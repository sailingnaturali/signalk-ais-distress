'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makePlugin = require('../index');

const EPIRB_CTX = 'vessels.urn:mrn:imo:mmsi:974321098';
const SHIP_CTX = 'vessels.urn:mrn:imo:mmsi:338040079';
const POS = { latitude: 48.79, longitude: -123.26 };

function mockApp() {
  const app = {};
  app.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-distress-'));
  app.getDataDirPath = () => app.dataDir;
  app.getSelfPath = (p) => (p === 'navigation.position' ? { value: { latitude: 48.76, longitude: -123.23 } } : undefined);
  app.paths = { [`${EPIRB_CTX}.navigation.state`]: { value: 'ais-sart' } };
  app.getPath = (p) => app.paths[p];
  app.deltas = [];
  app.handleMessage = (id, delta) => app.deltas.push({ id, delta });
  app.resourceProviders = {};
  app.registerResourceProvider = (provider) => {
    app.resourceProviders[provider.type] = provider;
  };
  app.putHandlers = {};
  app.registerPutHandler = (ctx, p, cb) => {
    app.putHandlers[`${ctx}:${p}`] = cb;
  };
  app.busHandlers = {};
  app.streambundle = {
    getBus: (p) => ({
      onValue: (cb) => {
        app.busHandlers[p] = cb;
        return () => delete app.busHandlers[p];
      },
    }),
  };
  app.error = () => {};
  app.debug = () => {};
  app.setPluginStatus = () => {};
  app.n2kHandlers = {};
  app.on = (evt, cb) => { app.n2kHandlers[evt] = cb; };
  app.removeListener = (evt) => { delete app.n2kHandlers[evt]; };
  return app;
}

function start(app, options = {}) {
  const plugin = makePlugin(app);
  // Disable the restart reannounce timer for deterministic tests.
  plugin.start({ logbookToken: '', reannounceDelayMs: 1e9, ...options });
  return plugin;
}

function pushPosition(app, context, value) {
  app.busHandlers['navigation.position']({ context, value });
}

function feedPgn(app, fields) {
  app.n2kHandlers['N2KAnalyzerOut']({ pgn: 129802, fields });
}
// Alarms now live at per-call paths notifications.received.<category>.ais-<id>,
// so match by prefix. The device type (sart/mob/epirb) is no longer in the
// received actuation path — it lives in the stored event and the per-vessel
// record — so alarmsFor finds every beacon alarm (all distress-priority).
function broadcastsFor(app, category) {
  return app.deltas.filter((d) =>
    d.delta.updates[0].values[0].path.startsWith(`notifications.received.${category}.ais-`)
  );
}

function alarmsFor(app) {
  return app.deltas.filter((d) =>
    d.delta.updates[0].values[0].path.startsWith('notifications.received.distress.ais-')
  );
}

test('a 974 EPIRB beacon raises an emergency notification and is stored', async () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);

  const alarms = alarmsFor(app);
  assert.equal(alarms.length, 1);
  const value = alarms[0].delta.updates[0].values[0].value;
  assert.equal(value.state, 'emergency');
  assert.match(value.message, /^AIS EPIRB beacon,/);

  const stored = await app.resourceProviders['ais-distress'].methods.listResources();
  const events = Object.values(stored);
  assert.equal(events.length, 1);
  assert.equal(events[0].mmsi, '974321098');
  assert.equal(events[0].deviceBeacon, 'epirb');
  assert.equal(events[0].state, 'ais-sart');
  plugin.stop();
});

test('two concurrent beacons get distinct keys, each acked independently', async () => {
  const app = mockApp();
  const CTX2 = 'vessels.urn:mrn:imo:mmsi:974555111';
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);   // mmsi 974321098
  pushPosition(app, CTX2, POS);        // mmsi 974555111

  const paths = alarmsFor(app).map((d) => d.delta.updates[0].values[0].path);
  const a = paths.find((p) => p.includes('974321098'));
  const b = paths.find((p) => p.includes('974555111'));
  assert.ok(a && b && a !== b, 'each beacon raised at its own per-call path');

  app.putHandlers[`vessels.self:${a}`](); // ack just the first
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.ok(stored.find((e) => e.mmsi === '974321098').clearedAt, 'acked beacon cleared');
  assert.equal(stored.find((e) => e.mmsi === '974555111').clearedAt, undefined, 'other beacon still active');
  plugin.stop();
});

test('repeated bursts from the same beacon update, not re-alarm', async () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);
  pushPosition(app, EPIRB_CTX, { latitude: 48.8, longitude: -123.27 });
  pushPosition(app, EPIRB_CTX, { latitude: 48.81, longitude: -123.28 });

  assert.equal(alarmsFor(app, 'epirb').length, 1); // alarmed once
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].repeats, 2);
  plugin.stop();
});

// A survival beacon transmits for hours, far longer than the 5-min dedupe
// window. Each burst must slide the window forward — otherwise a fresh event is
// minted every window, re-alarming and losing an operator's clear.
test('a beacon transmitting past the dedupe window updates one event, never re-alarms', async () => {
  const app = mockApp();
  const plugin = start(app);
  const realNow = Date.now;
  try {
    const t0 = Date.parse('2026-06-30T20:00:00.000Z');
    for (let m = 0; m <= 20; m += 2) { // a burst every 2 min for 20 min
      Date.now = () => t0 + m * 60 * 1000;
      pushPosition(app, EPIRB_CTX, { latitude: 48.79 + m * 1e-4, longitude: -123.26 });
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(alarmsFor(app, 'epirb').length, 1); // one incident, alarmed once
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1); // not one event per window
  plugin.stop();
});

test('an operator clear survives a beacon that keeps transmitting past the window', async () => {
  const app = mockApp();
  const plugin = start(app);
  const realNow = Date.now;
  try {
    const t0 = Date.parse('2026-06-30T20:00:00.000Z');
    Date.now = () => t0;
    pushPosition(app, EPIRB_CTX, POS);
    app.putHandlers['vessels.self:notifications.received.ais.distress.epirb'](); // operator acks
    for (let m = 2; m <= 20; m += 2) {
      Date.now = () => t0 + m * 60 * 1000;
      pushPosition(app, EPIRB_CTX, POS);
    }
  } finally {
    Date.now = realNow;
  }
  const raises = app.deltas.filter(
    (d) =>
      d.delta.updates[0].values[0].path.startsWith('notifications.received.distress.ais-') &&
      d.delta.updates[0].values[0].value &&
      d.delta.updates[0].values[0].value.state === 'emergency'
  );
  assert.equal(raises.length, 1); // the initial raise, never re-raised by later bursts
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1);
  assert.ok(stored[0].clearedAt); // clear is never undone
  plugin.stop();
});

test('after a restart, an active beacon re-announces via notifier.reannounce', async () => {
  const app = mockApp();
  const p1 = start(app);
  pushPosition(app, EPIRB_CTX, POS);
  p1.stop();
  app.deltas.length = 0; // forget the initial alarm

  // Fresh plugin over the same data dir reloads the JSONL store; fire the timer fast.
  const p2 = makePlugin(app);
  p2.start({ logbookToken: '', reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 10));
  const raises = alarmsFor(app).filter(
    (d) => d.delta.updates[0].values[0].value && d.delta.updates[0].values[0].value.state === 'emergency'
  );
  assert.equal(raises.length, 1); // re-raised on restart
  p2.stop();
});

test('plugin.start degrades gracefully when the position stream is unavailable', () => {
  const app = mockApp();
  delete app.streambundle; // SignalK's plugin-ci harness starts with a minimal app
  const errors = [];
  app.error = (m) => errors.push(m);
  const plugin = makePlugin(app);
  assert.doesNotThrow(() => plugin.start({ logbookToken: '', reannounceDelayMs: 1e9 }));
  assert.ok(errors.some((e) => /position stream|streambundle/i.test(e)), 'should log a clear error');
  plugin.stop();
});

test('an ordinary vessel position is ignored', async () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, SHIP_CTX, POS);

  assert.equal(app.deltas.length, 0);
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 0);
  plugin.stop();
});

test('the beacon appears on the ais-distress-markers chart layer, bucketed by device', async () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);

  const sets = await app.resourceProviders['ais-distress-markers'].methods.listResources();
  assert.equal(sets.epirb.type, 'ResourceSet');
  assert.equal(sets.epirb.name, 'AIS EPIRB');
  assert.equal(sets.epirb.values.features.length, 1);
  plugin.stop();
});

test('a PUT to the notification path clears the alarm and stamps the stored beacon', async () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);

  const result = app.putHandlers['vessels.self:notifications.received.ais.distress.epirb']();
  assert.equal(result.statusCode, 200);

  const cleared = app.deltas.filter(
    (d) => d.delta.updates[0].values[0].path.startsWith('notifications.received.distress.ais-') &&
      d.delta.updates[0].values[0].value === null
  );
  assert.equal(cleared.length, 1);
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.ok(stored[0].clearedAt);
  plugin.stop();
});

test('an AIS MAYDAY relay (Msg 14) raises an emergency broadcast alarm and stores it', async () => {
  const app = mockApp();
  const plugin = start(app);
  feedPgn(app, { sourceId: 3160001, safetyRelatedText: 'MAYDAY RELAY, s/v Blue Heron sinking' });
  const alarms = broadcastsFor(app, 'distress');
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].delta.updates[0].values[0].value.state, 'emergency');
  assert.match(alarms[0].delta.updates[0].values[0].value.message, /^AIS MAYDAY relay: /);
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'safetyBroadcast');
  assert.equal(stored[0].category, 'distress');
  plugin.stop();
});

test('PAN PAN → alarm, SECURITE → warn', () => {
  const app = mockApp();
  const plugin = start(app);
  feedPgn(app, { sourceId: 3160001, safetyRelatedText: 'PAN PAN, disabled vessel' });
  feedPgn(app, { sourceId: 3160002, safetyRelatedText: 'SECURITE, buoy adrift' });
  assert.equal(broadcastsFor(app, 'urgency')[0].delta.updates[0].values[0].value.state, 'alarm');
  assert.equal(broadcastsFor(app, 'safety')[0].delta.updates[0].values[0].value.state, 'warn');
  plugin.stop();
});

test('a routine safety broadcast is stored but never alarmed', async () => {
  const app = mockApp();
  const plugin = start(app);
  feedPgn(app, { sourceId: 3160001, safetyRelatedText: 'Navigation warning: buoy 42 unlit' });
  assert.equal(app.deltas.length, 0);
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].category, 'routine');
  plugin.stop();
});

test('a repeated relay updates one event, alarms once', async () => {
  const app = mockApp();
  const plugin = start(app);
  const f = { sourceId: 3160001, safetyRelatedText: 'MAYDAY RELAY, s/v Blue Heron' };
  feedPgn(app, f); feedPgn(app, f); feedPgn(app, f);
  assert.equal(broadcastsFor(app, 'distress').length, 1);
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].repeats, 2);
  plugin.stop();
});

test('a text-only broadcast never appears on the chart-marker layer', async () => {
  const app = mockApp();
  const plugin = start(app);
  feedPgn(app, { sourceId: 3160001, safetyRelatedText: 'MAYDAY RELAY, s/v Blue Heron' });
  const sets = await app.resourceProviders['ais-distress-markers'].methods.listResources();
  assert.equal(Object.keys(sets).length, 0);
  plugin.stop();
});

// Target-context emission (SignalK "other alarms" model): a received distress is
// data about the *source* vessel, so it also surfaces in that vessel's context —
// the self notifications.received.ais.distress.* alarm stays as the actuation layer.
const MOB_CTX = 'vessels.urn:mrn:imo:mmsi:972321098';

function targetNotesFor(app, context, leaf) {
  return app.deltas.filter(
    (d) => d.delta.context === context &&
      d.delta.updates[0].values[0].path === `notifications.${leaf}`
  );
}

test('a MOB beacon raises notifications.mob in the MOB source-vessel context', () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, MOB_CTX, POS);

  const notes = targetNotesFor(app, MOB_CTX, 'mob');
  assert.equal(notes.length, 1, 'one notification under the MOB vessel context');
  const value = notes[0].delta.updates[0].values[0].value;
  assert.equal(value.state, 'emergency');
  assert.deepEqual(value.method, ['visual', 'sound']);
  assert.ok(value.message, 'carries the spoken message');
  plugin.stop();
});

// Own position in mockApp is 48.76, -123.23: POS is about 2 NM away, NEAR about 0.4 NM.
const NEAR = { latitude: 48.765, longitude: -123.235 };

function ownMobFor(app, mmsi) {
  return app.deltas.filter(
    (d) => !d.delta.context && d.delta.updates[0].values[0].path === `notifications.mob.${mmsi}`
  );
}

test('a beacon within range raises our own MOB at the beacon position', () => {
  for (const [ctx, mmsi, beacon] of [
    [MOB_CTX, MOB_CTX.split(':').pop(), 'mob'],
    ['vessels.urn:mrn:imo:mmsi:970111222', '970111222', 'sart'],
    [EPIRB_CTX, '974321098', 'epirb'],
  ]) {
    const app = mockApp();
    const plugin = start(app);
    pushPosition(app, ctx, NEAR);

    const own = ownMobFor(app, mmsi);
    assert.equal(own.length, 1, `own MOB raised for ${beacon}`);
    const value = own[0].delta.updates[0].values[0].value;
    assert.equal(value.state, 'emergency');
    assert.deepEqual(value.method, ['visual', 'sound']);
    assert.deepEqual(value.position, NEAR);
    assert.deepEqual(value.data, { mmsi, beacon });
    assert.equal(alarmsFor(app).length, 1, 'received alarm still raised');
    plugin.stop();
  }
});

test('a beacon beyond range does not raise our own MOB', () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, MOB_CTX, POS);
  assert.equal(ownMobFor(app, MOB_CTX.split(':').pop()).length, 0);
  assert.equal(
    app.deltas.filter((d) => !d.delta.context && d.delta.updates[0].values[0].path === 'notifications.mob').length,
    0,
    'no flat self notifications.mob'
  );
  plugin.stop();
});

test('ownMobRangeNm 0 turns our own MOB off', () => {
  const app = mockApp();
  const plugin = start(app, { ownMobRangeNm: 0 });
  pushPosition(app, MOB_CTX, NEAR);
  assert.equal(ownMobFor(app, MOB_CTX.split(':').pop()).length, 0);
  plugin.stop();
});

test('our own MOB follows the beacon as it drifts, even out of range', () => {
  const app = mockApp();
  const mmsi = MOB_CTX.split(':').pop();
  const plugin = start(app);
  pushPosition(app, MOB_CTX, NEAR);
  pushPosition(app, MOB_CTX, POS);

  const own = ownMobFor(app, mmsi);
  assert.equal(own.length, 2);
  assert.deepEqual(own[1].delta.updates[0].values[0].value.position, POS);
  assert.equal(alarmsFor(app).length, 1, 'repeat does not re-raise the received alarm');
  plugin.stop();
});

test('clearing our own MOB clears the beacon and keeps it silent', () => {
  const app = mockApp();
  const mmsi = MOB_CTX.split(':').pop();
  const plugin = start(app);
  pushPosition(app, MOB_CTX, NEAR);

  app.putHandlers[`vessels.self:notifications.mob.${mmsi}`]();
  const own = ownMobFor(app, mmsi);
  assert.equal(own.at(-1).delta.updates[0].values[0].value, null, 'own MOB cleared');
  const received = alarmsFor(app);
  assert.equal(received.at(-1).delta.updates[0].values[0].value, null, 'received alarm cleared');

  pushPosition(app, MOB_CTX, NEAR);
  assert.equal(ownMobFor(app, mmsi).length, own.length, 'a cleared beacon stays silent');
  plugin.stop();
});

test('acking the received alarm also clears our own MOB', () => {
  const app = mockApp();
  const mmsi = MOB_CTX.split(':').pop();
  const plugin = start(app);
  pushPosition(app, MOB_CTX, NEAR);

  const receivedPath = alarmsFor(app)[0].delta.updates[0].values[0].path;
  app.putHandlers[`vessels.self:${receivedPath}`]();
  assert.equal(ownMobFor(app, mmsi).at(-1).delta.updates[0].values[0].value, null);
  plugin.stop();
});

test('our own MOB is re-raised after a restart', async () => {
  const app = mockApp();
  const mmsi = MOB_CTX.split(':').pop();
  const first = start(app);
  pushPosition(app, MOB_CTX, NEAR);
  first.stop();

  app.deltas = [];
  const second = makePlugin(app);
  second.start({ logbookToken: '', reannounceDelayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const own = ownMobFor(app, mmsi);
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].delta.updates[0].values[0].value.position, NEAR);
  second.stop();
});

test('our own MOB can still be cleared after the same instance restarts', async () => {
  const app = mockApp();
  const mmsi = MOB_CTX.split(':').pop();
  const plugin = start(app);
  pushPosition(app, MOB_CTX, NEAR);
  plugin.stop();

  // The server unregisters a plugin's PUT handlers when it stops.
  app.putHandlers = {};
  plugin.start({ logbookToken: '', reannounceDelayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const handler = app.putHandlers[`vessels.self:notifications.mob.${mmsi}`];
  assert.ok(handler, 'own MOB PUT handler registered again');
  handler();
  assert.equal(ownMobFor(app, mmsi).at(-1).delta.updates[0].values[0].value, null);
  plugin.stop();
});

// A beacon isn't necessarily a vessel (a personal EPIRB/SART is a device), and
// SART/EPIRB carry no nature-of-distress — so a non-MOB beacon surfaces under the
// maritime-priority leaf notifications.distress, not an invented device-type leaf.
test('a non-MOB beacon surfaces under notifications.distress in the source-vessel context', () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);

  const notes = targetNotesFor(app, EPIRB_CTX, 'distress');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].delta.updates[0].values[0].value.state, 'emergency');
  assert.equal(targetNotesFor(app, EPIRB_CTX, 'epirb').length, 0, 'no device-type leaf');
  // and the self alarm still fires (actuation layer unchanged)
  assert.equal(alarmsFor(app, 'epirb').length, 1);
  plugin.stop();
});
