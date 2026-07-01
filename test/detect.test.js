'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mmsiFromContext, buildBeaconEvent } = require('../lib/detect');

test('mmsiFromContext extracts the MMSI from a vessel context urn', () => {
  assert.equal(mmsiFromContext('vessels.urn:mrn:imo:mmsi:974321098'), '974321098');
  assert.equal(mmsiFromContext('vessels.urn:mrn:signalk:uuid:abc'), undefined);
  assert.equal(mmsiFromContext(undefined), undefined);
});

test('buildBeaconEvent returns an AIS distress event for a 974 EPIRB context', () => {
  const ev = buildBeaconEvent({
    context: 'vessels.urn:mrn:imo:mmsi:974321098',
    position: { latitude: 48.79, longitude: -123.26 },
    state: 'ais-sart',
    now: Date.parse('2026-06-30T20:19:30.000Z'),
  });
  assert.equal(ev.source, 'ais');
  assert.equal(ev.category, 'distress');
  assert.equal(ev.deviceBeacon, 'epirb');
  assert.equal(ev.mmsi, '974321098');
  assert.equal(ev.natureOfDistress, 'epirb');
  assert.equal(ev.state, 'ais-sart');
  assert.deepEqual(ev.position, { latitude: 48.79, longitude: -123.26 });
  assert.equal(ev.receivedAt, '2026-06-30T20:19:30.000Z');
});

test('buildBeaconEvent maps device classes: 972→mob (nature mob), 970→sart (no nature)', () => {
  const mob = buildBeaconEvent({ context: 'vessels.urn:mrn:imo:mmsi:972321098', position: { latitude: 1, longitude: 2 }, now: 0 });
  assert.equal(mob.deviceBeacon, 'mob');
  assert.equal(mob.natureOfDistress, 'mob');
  const sart = buildBeaconEvent({ context: 'vessels.urn:mrn:imo:mmsi:970321098', position: { latitude: 1, longitude: 2 }, now: 0 });
  assert.equal(sart.deviceBeacon, 'sart');
  assert.equal(sart.natureOfDistress, undefined);
});

test('buildBeaconEvent returns null for a non-beacon vessel', () => {
  const ev = buildBeaconEvent({ context: 'vessels.urn:mrn:imo:mmsi:338040079', position: { latitude: 1, longitude: 2 }, now: 0 });
  assert.equal(ev, null);
});
