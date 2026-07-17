'use strict';

// Guard/regression tests for the AIS Msg-14 broadcast path sharing one
// EventStore with the beacon path (Findings 1 & 2 revisited). Hand-off file:
// three of these are RED against 0.2.0 and should drive the fix; the fourth
// (dedupe-past-window) locks in behaviour that already works.
//
//   1. beacon-path reannounce must NOT re-raise broadcast events on restart
//      (today it raises them at notifications.received.ais.distress.undefined @ emergency,
//      routine ones included) — RED
//   2. a live relay alarm must survive a restart on its own broadcast path — RED
//   3. a PUT to notifications.received.ais.broadcast.<category> must clear the alarm and
//      not resurrect it on restart — RED (no handler registered today)
//   4. a relay repeating past the 5-min dedupe window stays one event, alarmed
//      once (Finding 1's lastReceivedAt slide, for the text-keyed dedupe) — GREEN

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makePlugin = require('../index');

const MAYDAY = { sourceId: 3160001, safetyRelatedText: 'MAYDAY RELAY, s/v Blue Heron sinking' };
const ROUTINE = { sourceId: 3160002, safetyRelatedText: 'Navigation warning: buoy 42 unlit' };

function mockApp() {
  const app = {};
  app.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-broadcast-'));
  app.getDataDirPath = () => app.dataDir;
  app.getSelfPath = (p) => (p === 'navigation.position' ? { value: { latitude: 48.76, longitude: -123.23 } } : undefined);
  app.getPath = () => undefined;
  app.deltas = [];
  app.handleMessage = (id, delta) => app.deltas.push({ id, delta });
  app.resourceProviders = {};
  app.registerResourceProvider = (provider) => { app.resourceProviders[provider.type] = provider; };
  app.putHandlers = {};
  app.registerPutHandler = (ctx, p, cb) => { app.putHandlers[`${ctx}:${p}`] = cb; };
  app.streambundle = { getBus: () => ({ onValue: () => () => {} }) };
  app.n2kHandlers = {};
  app.on = (evt, cb) => { app.n2kHandlers[evt] = cb; };
  app.removeListener = (evt) => { delete app.n2kHandlers[evt]; };
  app.error = () => {};
  app.debug = () => {};
  app.setPluginStatus = () => {};
  return app;
}

function start(app, options = {}) {
  const plugin = makePlugin(app);
  plugin.start({ logbookToken: '', reannounceDelayMs: 1e9, ...options });
  return plugin;
}

function feedPgn(app, fields) {
  app.n2kHandlers['N2KAnalyzerOut']({ pgn: 129802, fields });
}

function deltasOnPath(app, re) {
  return app.deltas.filter((d) => re.test(d.delta.updates[0].values[0].path));
}
function raisesOn(app, pathStr) {
  return app.deltas.filter(
    (d) => d.delta.updates[0].values[0].path === pathStr && d.delta.updates[0].values[0].value
  );
}

// 1 — cross-contamination guard (RED)
test('a stored broadcast is never re-raised on the beacon path after a restart', async () => {
  const app = mockApp();
  const p1 = start(app);
  feedPgn(app, MAYDAY);   // distress broadcast, alarms on notifications.received.ais.broadcast.distress
  feedPgn(app, ROUTINE);  // routine, stored but never alarmed
  p1.stop();
  app.deltas.length = 0;

  const p2 = makePlugin(app);
  p2.start({ logbookToken: '', reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 10));

  // The beacon notifier (stateFor: () => 'emergency', pathFor keyed on an
  // absent deviceBeacon) must not touch broadcast events.
  assert.equal(
    deltasOnPath(app, /^notifications\.ais\.distress\./).length, 0,
    'broadcast events leaked onto the beacon notification path on restart'
  );
  p2.stop();
});

// 2 — broadcast reannounce survives a restart (RED)
test('an active relay alarm re-announces on its broadcast path after a restart', async () => {
  const app = mockApp();
  const p1 = start(app);
  feedPgn(app, MAYDAY);
  p1.stop();
  app.deltas.length = 0;

  const p2 = makePlugin(app);
  p2.start({ logbookToken: '', reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 10));

  const raises = raisesOn(app, 'notifications.received.ais.broadcast.distress')
    .filter((d) => d.delta.updates[0].values[0].value.state === 'alarm');
  assert.equal(raises.length, 1, 'relay alarm did not survive the restart');
  p2.stop();
});

// 3 — operator clear for a broadcast alarm (RED)
test('a PUT to the broadcast path clears the alarm and it stays cleared across a restart', async () => {
  const app = mockApp();
  const p1 = start(app);
  feedPgn(app, MAYDAY);

  const handler = app.putHandlers['vessels.self:notifications.received.ais.broadcast.distress'];
  assert.ok(handler, 'no PUT clear handler registered for the broadcast path');
  const result = handler('vessels.self', 'notifications.received.ais.broadcast.distress', null, () => {});
  assert.equal(result.statusCode, 200);

  const nulls = app.deltas.filter(
    (d) => d.delta.updates[0].values[0].path === 'notifications.received.ais.broadcast.distress' &&
      d.delta.updates[0].values[0].value === null
  );
  assert.equal(nulls.length, 1, 'clear did not emit a null delta');
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.ok(stored[0].clearedAt, 'stored broadcast was not stamped cleared');
  p1.stop();

  // A cleared relay must not be resurrected by the restart reannounce.
  app.deltas.length = 0;
  const p2 = makePlugin(app);
  p2.start({ logbookToken: '', reannounceDelayMs: 0 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(raisesOn(app, 'notifications.received.ais.broadcast.distress').length, 0, 'cleared relay re-raised on restart');
  p2.stop();
});

// 4 — dedupe past the window (GREEN regression: Finding 1 for text-keyed dedupe)
test('a relay repeating past the dedupe window stays one event, alarmed once', async () => {
  const app = mockApp();
  const plugin = start(app);
  const realNow = Date.now;
  try {
    const t0 = Date.parse('2026-07-08T20:00:00.000Z');
    for (let m = 0; m <= 20; m += 2) { // a rebroadcast every 2 min for 20 min
      Date.now = () => t0 + m * 60 * 1000;
      feedPgn(app, MAYDAY);
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(raisesOn(app, 'notifications.received.ais.broadcast.distress').length, 1, 're-alarmed past the window');
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.equal(stored.length, 1, 'minted more than one event for one relay');
  plugin.stop();
});
