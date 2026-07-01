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

function alarmsFor(app, beacon) {
  return app.deltas.filter(
    (d) => d.delta.updates[0].values[0].path === `notifications.ais.distress.${beacon}`
  );
}

test('a 974 EPIRB beacon raises an emergency notification and is stored', async () => {
  const app = mockApp();
  const plugin = start(app);
  pushPosition(app, EPIRB_CTX, POS);

  const alarms = alarmsFor(app, 'epirb');
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

  const result = app.putHandlers['vessels.self:notifications.ais.distress.epirb']();
  assert.equal(result.statusCode, 200);

  const cleared = app.deltas.filter(
    (d) => d.delta.updates[0].values[0].path === 'notifications.ais.distress.epirb' &&
      d.delta.updates[0].values[0].value === null
  );
  assert.equal(cleared.length, 1);
  const stored = Object.values(await app.resourceProviders['ais-distress'].methods.listResources());
  assert.ok(stored[0].clearedAt);
  plugin.stop();
});
