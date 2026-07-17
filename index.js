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
 *   - raises notifications.received.ais.distress.<sart|mob|epirb> under *self* at
 *     emergency, so the vessel's own alarm chain fires
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
  writeLogbookEntry,
} = require('@sailingnaturali/signalk-distress-core');

const { buildBeaconEvent } = require('./lib/detect');
const { normalizePgn129802 } = require('./lib/pgn129802');
const { classify } = require('./lib/classify');

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const REANNOUNCE_WINDOW_MS = 60 * 60 * 1000;
const MSG14_PGN = 129802;
// AIS Msg-14 safety broadcasts carry the three ITU priority categories; they map
// to spec zones distress → alarm, urgency → warn, safety → alert. (Survival beacons
// — SART/MOB/EPIRB — are not a voice category and stay emergency; see the beacon
// notifier below and the source-vessel record in notifyTarget.)
const BROADCAST_STATES = { distress: 'alarm', urgency: 'warn', safety: 'alert' };

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

  const notifier = createNotifier({
    app,
    pluginId: plugin.id,
    pathFor: (event) => `notifications.received.ais.distress.${event.deviceBeacon}`,
    stateFor: () => 'emergency',
  });

  const broadcastNotifier = createNotifier({
    app,
    pluginId: plugin.id,
    pathFor: (event) => `notifications.received.ais.broadcast.${event.category}`,
    stateFor: (event) => BROADCAST_STATES[event.category],
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
    // Also feed the flat legacy self-key so existing MOB subscribers (e.g.
    // meshtastic waypoint minting) keep firing until they migrate to the
    // received.* / per-vessel scheme (SK spec thread 2026-07-15).
    if (leaf === 'mob') {
      app.handleMessage(plugin.id, { updates: [{ values: [{ path: 'notifications.mob', value }] }] });
    }
  }

  function notify(event) {
    refreshMessage(event);
    notifier.raise(event);
    notifyTarget(event);
  }

  /** Clear an active beacon alarm: drop the live notification and stamp the
   *  stored events so a restart reannounce skips them. */
  function clearBeacon(beacon) {
    notifier.clear(`notifications.received.ais.distress.${beacon}`);
    store.markCleared((e) => e.deviceBeacon === beacon, new Date().toISOString());
  }

  /** Clear an active broadcast (Msg 14 relay) alarm: drop the live notification
   *  and stamp the stored relay(s) so a restart reannounce skips them. */
  function clearBroadcast(category) {
    broadcastNotifier.clear(`notifications.received.ais.broadcast.${category}`);
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
      return duplicate;
    }

    event.ownShip = captureOwnShip(app, options.snapshotPaths);
    const stored = store.add(event);
    notify(stored);
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
      // reannounceDelayMs is an undocumented test seam (schema-hidden): tests set
      // it to 0 to fire immediately or a huge value to disable the timer.
    }, options.reannounceDelayMs ?? 30000);
  };

  plugin.stop = function () {
    started = false;
    clearTimeout(reannounceTimer);
    if (positionUnsub) positionUnsub();
    positionUnsub = null;
    app.removeListener('N2KAnalyzerOut', onPgn);
  };

  return plugin;
};
