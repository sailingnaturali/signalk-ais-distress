'use strict';

/*
 * signalk-ais-distress
 *
 * AIS survival-beacon monitoring. SART, MOB, and EPIRB locating devices (MMSI
 * prefixes 970 / 972 / 974) broadcast their GNSS position over AIS to every
 * receiver in range. SignalK decodes them into vessel targets, but nothing
 * flags them — an active survival beacon appears as just another boat.
 *
 * This plugin subscribes to the position stream, and for every 97x beacon it
 * hears:
 *   - appends it to an on-disk JSONL log (forensics: the full record is kept)
 *   - serves the beacon history at /signalk/v2/api/resources/ais-distress
 *   - serves a chart-marker layer at /signalk/v2/api/resources/ais-distress-markers
 *   - raises a per-call notifications.received.distress.ais-<id> under *self* at
 *     emergency, so the vessel's own alarm chain fires (bulk clear-by-beacon via
 *     notifications.received.ais.distress.<sart|mob|epirb>)
 *   - when the beacon is within ownMobRangeNm of own position, also raises our
 *     own notifications.mob.<mmsi> at the beacon's position
 *   - optionally writes a ship's-log entry via signalk-logbook
 *
 * A beacon repeats its position several times a minute; repeats inside a
 * 5-minute window update the stored event instead of re-alarming.
 */

const path = require('node:path');

const {
  EventStore,
  buildMarkerResourceSets,
  buildMessage,
  buildLogbookText,
  captureOwnShip,
  buildObservations,
  createNotifier,
  distanceNm,
  receivedPath,
  writeLogbookEntry,
} = require('@sailingnaturali/signalk-distress-core');

const { buildBeaconEvent } = require('./lib/detect');
const { normalizePgn129802 } = require('./lib/pgn129802');
const { classify } = require('./lib/classify');

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const REANNOUNCE_WINDOW_MS = 60 * 60 * 1000;
const MSG14_PGN = 129802;
const BROADCAST_STATES = { distress: 'emergency', urgency: 'alarm', safety: 'warn' };
const DEFAULT_OWN_MOB_RANGE_NM = 1;

// One red family for every survival beacon — this is always an emergency.
const BEACON_COLORS = {
  sart: 'rgba(211,47,47,1)',
  mob: 'rgba(211,47,47,1)',
  epirb: 'rgba(211,47,47,1)',
};
const BEACON_LABEL = { sart: 'AIS SART', mob: 'AIS MOB', epirb: 'AIS EPIRB' };

module.exports = function makePlugin(app) {
  const plugin = {
    id: 'signalk-ais-distress',
    name: 'AIS Distress',
    description:
      'Alert on AIS distress beacons (SART / MOB / EPIRB, MMSI 970/972/974): notifications, chart markers, forensic log, and ship\'s-log entries.',
  };

  plugin.schema = {
    type: 'object',
    properties: {
      maxEvents: {
        type: 'number',
        title: 'Beacons to keep',
        description: 'Oldest beacon events are dropped beyond this count.',
        default: 1000,
      },
      markerWindowHours: {
        type: 'number',
        title: 'Chart marker window (hours)',
        description:
          'Beacons drop off the ais-distress-markers chart layer after this many hours. Active (un-cleared) beacons always remain.',
        default: 24,
      },
      ownMobRangeNm: {
        type: 'number',
        title: 'Treat a nearby beacon as our own person overboard (nautical miles)',
        description:
          'A SART, MOB or EPIRB beacon heard within this range of own position also raises our own MOB alarm (notifications.mob.<mmsi>) at the beacon\'s position, which follows the beacon as it drifts. 0 turns this off.',
        default: DEFAULT_OWN_MOB_RANGE_NM,
        minimum: 0,
      },
      logbookEnabled: {
        type: 'boolean',
        title: 'Write beacons to the ship\'s log (signalk-logbook)',
        default: true,
      },
      logbookUrl: {
        type: 'string',
        title: 'Logbook API URL',
        default: 'http://localhost:3000/plugins/signalk-logbook/logs',
      },
      logbookToken: {
        type: 'string',
        title: 'SignalK access token for logbook writes',
        description: 'Plugin routes are auth-gated; without a token the logbook write is skipped.',
        default: '',
      },
      snapshotPaths: {
        type: 'array',
        title: 'Extra own-ship paths to snapshot on each beacon',
        default: [],
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', title: 'Field name in ownShip' },
            path: { type: 'string', title: 'SignalK self path' },
          },
        },
      },
    },
  };

  let options = {};
  let store = null;
  let started = false;
  let reannounceTimer = null;
  let positionUnsub = null;

  // A consumer acking one alarm clears just that call: stamp it so the restart
  // reannounce skips it (bulk clear-by-beacon/category lives in clearBeacon /
  // clearBroadcast). Survival beacons are all distress-priority.
  const ackOne = (event) => {
    if (event.ownMob) clearOwnMob(event);
    store.markCleared(
      (e) => e.id === event.id || (event.ownMob && e.ownMob && e.mmsi === event.mmsi),
      new Date().toISOString()
    );
  };

  const notifier = createNotifier({
    app,
    pluginId: plugin.id,
    pathFor: (event) => receivedPath('distress', 'ais', event.id),
    stateFor: () => 'emergency',
    onCleared: ackOne,
  });

  const broadcastNotifier = createNotifier({
    app,
    pluginId: plugin.id,
    pathFor: (event) => receivedPath(event.category, 'ais', event.id),
    stateFor: (event) => BROADCAST_STATES[event.category],
    onCleared: ackOne,
  });

  function selfPosition() {
    const p = app.getSelfPath && app.getSelfPath('navigation.position');
    return p && p.value ? p.value : p;
  }

  function vesselName(mmsi) {
    try {
      const node = app.getPath(`vessels.urn:mrn:imo:mmsi:${mmsi}.name`);
      return node && typeof node === 'object' ? node.value : node;
    } catch {
      return undefined;
    }
  }

  function readState(context) {
    try {
      const node = app.getPath(`${context}.navigation.state`);
      return node && typeof node === 'object' ? node.value : node;
    } catch {
      return undefined;
    }
  }

  function messageContext(event) {
    return { ownPosition: selfPosition(), vesselName: vesselName(event.mmsi) };
  }

  // Rebuild the spoken message against the current own-ship position — range
  // and direction ("N miles <direction>") shift as we move. Terse on purpose:
  // this string gets spoken; full detail lives in the store and the logbook.
  function refreshMessage(event) {
    event.message = buildMessage(event, messageContext(event));
    return event;
  }

  // Mirror signalk-dsc: besides the self alarm, surface the distress in the
  // *source vessel's* context, so a consumer reading that AIS target sees its
  // emergency (SignalK "other alarms" model — as if the vessel raised it). The
  // self notifications.received.ais.distress.* alarm is the actuation layer our own
  // annunciator subscribes to; this is the interoperable state record.
  // Leaf: MOB → notifications.mob (a real spec nature, and what meshtastic keys on
  // to mint a MOB waypoint). SART/EPIRB carry no nature and a beacon isn't
  // necessarily a vessel (personal EPIRB/PLB), so they surface under the maritime
  // priority leaf notifications.distress rather than an invented device-type path.
  function notifyTarget(event) {
    if (!event.mmsi) return;
    const leaf = event.deviceBeacon === 'mob' ? 'mob' : 'distress';
    const value = { state: 'emergency', method: ['visual', 'sound'], message: event.message };
    if (event.receivedAt) value.timestamp = event.receivedAt;
    app.handleMessage(plugin.id, {
      context: `vessels.urn:mrn:imo:mmsi:${event.mmsi}`,
      updates: [{ values: [{ path: `notifications.${leaf}`, value }] }],
    });
  }

  // A beacon this close to us is most likely our own crew, so it becomes our
  // own MOB. It carries the beacon's position, so a plotter can mark it and
  // steer to it, and it uses one key per beacon under notifications.mob.*, the
  // shape the server's own MOB and existing MOB consumers (signalk-mob-course,
  // meshtastic waypoints) already use.
  const ownMobPath = (event) => `notifications.mob.${event.mmsi}`;
  const ownMobAcks = new Set();

  function isNearby(position) {
    const range = options.ownMobRangeNm;
    const own = selfPosition();
    return (
      range > 0 &&
      Boolean(own) &&
      typeof own.latitude === 'number' &&
      Boolean(position) &&
      distanceNm(own, position) <= range
    );
  }

  function raiseOwnMob(event) {
    const path = ownMobPath(event);
    const value = {
      state: 'emergency',
      method: ['visual', 'sound'],
      message: event.message,
      position: event.position,
      data: { mmsi: event.mmsi, beacon: event.deviceBeacon },
    };
    const at = event.lastReceivedAt || event.receivedAt;
    if (at) value.timestamp = at;
    app.handleMessage(plugin.id, { updates: [{ values: [{ path, value }] }] });
    if (!ownMobAcks.has(path)) {
      ownMobAcks.add(path);
      app.registerPutHandler('vessels.self', path, () => {
        const current = activeOwnMobs(event.mmsi);
        if (current.length) {
          for (const e of current) notifier.clear(receivedPath('distress', 'ais', e.id));
          ackOne(current[0]);
        } else {
          app.handleMessage(plugin.id, { updates: [{ values: [{ path, value: null }] }] });
        }
        return { state: 'COMPLETED', statusCode: 200 };
      });
    }
  }

  function clearOwnMob(event) {
    app.handleMessage(plugin.id, { updates: [{ values: [{ path: ownMobPath(event), value: null }] }] });
  }

  // Once raised, our own MOB follows the beacon until someone clears it, even
  // if the beacon drifts out of range.
  // A beacon unheard for longer than the dedupe window comes back as a new
  // stored event, so own-MOB state is decided per MMSI, not per event.
  const activeOwnMobs = (mmsi) => store.list().filter((e) => e.ownMob && !e.clearedAt && e.mmsi === mmsi);

  function updateOwnMob(event) {
    if (event.clearedAt) return;
    if (!(event.ownMob || activeOwnMobs(event.mmsi).length || isNearby(event.position))) return;
    if (!event.ownMob) store.update(event.id, { ownMob: true });
    raiseOwnMob(refreshMessage(event));
  }

  function notify(event) {
    refreshMessage(event);
    notifier.raise(event);
    notifyTarget(event);
  }

  /** Bulk-clear every active beacon alarm of a type (the CLI / dashboard control
   *  path `notifications.received.ais.distress.<beacon>`): drop each live per-call
   *  notification and stamp the stored beacons so a restart reannounce skips them.
   *  (An individual alarm is acked at its own per-call path — see ackOne.) */
  function clearBeacon(beacon) {
    for (const e of store.list()) {
      if (e.deviceBeacon === beacon && !e.clearedAt) {
        notifier.clear(receivedPath('distress', 'ais', e.id));
        if (e.ownMob) clearOwnMob(e);
      }
    }
    store.markCleared((e) => e.deviceBeacon === beacon, new Date().toISOString());
  }

  /** Bulk-clear every active broadcast (Msg 14 relay) alarm of a category (the
   *  control path `notifications.received.ais.broadcast.<category>`): drop each
   *  live per-call notification and stamp the stored relay(s). */
  function clearBroadcast(category) {
    for (const e of store.list()) {
      if (e.kind === 'safetyBroadcast' && e.category === category && !e.clearedAt) {
        broadcastNotifier.clear(receivedPath(e.category, 'ais', e.id));
      }
    }
    store.markCleared(
      (e) => e.kind === 'safetyBroadcast' && e.category === category,
      new Date().toISOString()
    );
  }

  function shouldLogbook() {
    return options.logbookEnabled !== false && Boolean(options.logbookToken);
  }

  async function postLogbook(event) {
    await writeLogbookEntry({
      url: options.logbookUrl,
      token: options.logbookToken,
      text: buildLogbookText(event, messageContext(event)),
      observations: buildObservations(event.ownShip),
    });
  }

  /** Store a beacon, alarm on it, and log it. Returns the stored event. */
  function record(event) {
    event.receivedAt = event.receivedAt || new Date().toISOString();

    // A beacon repeats its position several times a minute: bump the stored
    // event, do not re-alarm. Matches on mmsi and ignores clearedAt, so an
    // operator-cleared beacon that keeps transmitting stays silent.
    const duplicate = store.findRecent(
      (e) => e.mmsi === event.mmsi,
      Date.parse(event.receivedAt),
      DEDUPE_WINDOW_MS
    );
    if (duplicate) {
      store.update(duplicate.id, {
        position: event.position || duplicate.position,
        state: event.state || duplicate.state,
        repeats: (duplicate.repeats || 0) + 1,
        lastReceivedAt: event.receivedAt,
      });
      updateOwnMob(duplicate);
      return duplicate;
    }

    event.ownShip = captureOwnShip(app, options.snapshotPaths);
    const stored = store.add(event);
    notify(stored);
    updateOwnMob(stored);
    if (shouldLogbook()) {
      postLogbook(stored).catch((err) => app.error(`ais-distress logbook write failed: ${err.message}`));
    }
    return stored;
  }

  function onPositionDelta(delta) {
    if (!delta || !delta.value || typeof delta.value.latitude !== 'number') return;
    const event = buildBeaconEvent({
      context: delta.context,
      position: delta.value,
      state: readState(delta.context),
      now: Date.now(),
    });
    if (event) record(event);
  }

  function recordBroadcast(event) {
    event.receivedAt = event.receivedAt || new Date().toISOString();
    event.category = classify(event.text);
    const duplicate = store.findRecent(
      (e) => e.kind === 'safetyBroadcast' && e.mmsi === event.mmsi && e.text === event.text,
      Date.parse(event.receivedAt),
      DEDUPE_WINDOW_MS
    );
    if (duplicate) {
      store.update(duplicate.id, { repeats: (duplicate.repeats || 0) + 1, lastReceivedAt: event.receivedAt });
      return duplicate;
    }
    event.ownShip = captureOwnShip(app, options.snapshotPaths);
    const stored = store.add(event);
    if (event.category !== 'routine') {
      stored.message = buildMessage(stored, messageContext(stored));
      broadcastNotifier.raise(stored);
      if (shouldLogbook()) {
        postLogbook(stored).catch((err) => app.error(`ais-distress logbook write failed: ${err.message}`));
      }
    }
    return stored;
  }

  function onPgn(pgnData) {
    if (!started || !pgnData || pgnData.pgn !== MSG14_PGN) return;
    try {
      const event = normalizePgn129802(pgnData);
      if (event) recordBroadcast(event);
    } catch (err) {
      app.error(`signalk-ais-distress: PGN 129802 handling failed: ${err.message}`);
    }
  }

  const buildSets = () =>
    buildMarkerResourceSets(store.list(), {
      now: Date.now(),
      windowHours: options.markerWindowHours,
      nameFor: vesselName,
      bucketOf: (e) => e.deviceBeacon,
      colors: BEACON_COLORS,
      label: (b) => BEACON_LABEL[b] || `AIS ${b}`,
      describe: (b) => `${BEACON_LABEL[b] || b} distress beacons heard on AIS`,
    });

  plugin.start = function (opts) {
    options = {
      maxEvents: 1000,
      markerWindowHours: 24,
      logbookEnabled: true,
      logbookUrl: 'http://localhost:3000/plugins/signalk-logbook/logs',
      logbookToken: '',
      snapshotPaths: [],
      ownMobRangeNm: DEFAULT_OWN_MOB_RANGE_NM,
      ...opts,
    };

    store = new EventStore({
      filePath: path.join(app.getDataDirPath(), 'ais-distress.jsonl'),
      maxEvents: options.maxEvents,
    });

    app.registerResourceProvider({
      type: 'ais-distress',
      methods: {
        async listResources() {
          const out = {};
          for (const event of store.list()) out[event.id] = event;
          return out;
        },
        async getResource(id) {
          const event = store.get(id);
          if (!event) throw new Error(`No such AIS distress beacon: ${id}`);
          return event;
        },
        setResource() {
          throw new Error('ais-distress is read-only');
        },
        deleteResource() {
          throw new Error('ais-distress is read-only');
        },
      },
    });

    app.registerResourceProvider({
      type: 'ais-distress-markers',
      methods: {
        async listResources() {
          return buildSets();
        },
        async getResource(id) {
          const sets = buildSets();
          if (!sets[id]) throw new Error(`No AIS distress beacons of type: ${id}`);
          return sets[id];
        },
        setResource() {
          throw new Error('ais-distress-markers is read-only');
        },
        deleteResource() {
          throw new Error('ais-distress-markers is read-only');
        },
      },
    });

    // Subscribe to every vessel's position stream. Guard against a minimal app
    // (e.g. SignalK's plugin-ci validation harness, or a server without the
    // streambundle) so start() degrades instead of throwing on load.
    const bus =
      app.streambundle && typeof app.streambundle.getBus === 'function'
        ? app.streambundle.getBus('navigation.position')
        : null;
    if (bus && typeof bus.onValue === 'function') {
      positionUnsub = bus.onValue(onPositionDelta);
    } else {
      app.error('navigation.position stream unavailable — AIS beacon detection disabled');
    }

    // Let an operator clear an active beacon alarm: a PUT to the notification
    // path drops the live alert and marks the stored beacon(s) so a restart
    // will not re-raise it.
    for (const beacon of ['sart', 'mob', 'epirb']) {
      app.registerPutHandler('vessels.self', `notifications.received.ais.distress.${beacon}`, () => {
        clearBeacon(beacon);
        return { state: 'COMPLETED', statusCode: 200 };
      });
    }

    // Same for a broadcast (Msg 14 relay) alarm, one path per severity.
    for (const category of ['distress', 'urgency', 'safety']) {
      app.registerPutHandler('vessels.self', `notifications.received.ais.broadcast.${category}`, () => {
        clearBroadcast(category);
        return { state: 'COMPLETED', statusCode: 200 };
      });
    }

    started = true;
    app.on('N2KAnalyzerOut', onPgn);

    // Survive server restarts mid-incident: re-raise the newest still-fresh
    // event per notification path. Two families share one store (beacon →
    // notifications.received.ais.distress.<beacon>, relay → notifications.received.ais.broadcast.
    // <category>), so reannounce each notifier over only its own events — else a
    // relay leaks onto the beacon path (raised at .undefined @ emergency) or a
    // beacon onto a broadcast path. Routine relays self-skip: broadcastNotifier's
    // stateFor is undefined for them and raise() no-ops on a falsy state. Delayed
    // so position providers are up and the spoken message can say "N miles <dir>".
    reannounceTimer = setTimeout(() => {
      if (!started) return;
      const events = store.list();
      notifier.reannounce(
        events.filter((e) => e.kind !== 'safetyBroadcast'),
        { window: REANNOUNCE_WINDOW_MS, prepare: refreshMessage }
      );
      broadcastNotifier.reannounce(
        events.filter((e) => e.kind === 'safetyBroadcast'),
        { window: REANNOUNCE_WINDOW_MS, prepare: refreshMessage }
      );
      const now = Date.now();
      for (const e of events) {
        const heard = Date.parse(e.lastReceivedAt || e.receivedAt);
        if (e.ownMob && !e.clearedAt && now - heard <= REANNOUNCE_WINDOW_MS) {
          raiseOwnMob(refreshMessage(e));
        }
      }
      // reannounceDelayMs is an undocumented test seam (schema-hidden): tests set
      // it to 0 to fire immediately or a huge value to disable the timer.
    }, options.reannounceDelayMs ?? 30000);
  };

  plugin.stop = function () {
    started = false;
    // The server unregisters a plugin's PUT handlers on stop, so a restart must register them again.
    ownMobAcks.clear();
    clearTimeout(reannounceTimer);
    if (positionUnsub) positionUnsub();
    positionUnsub = null;
    app.removeListener('N2KAnalyzerOut', onPgn);
  };

  return plugin;
};
