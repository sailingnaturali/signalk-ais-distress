'use strict';

const { deviceBeaconFor } = require('@sailingnaturali/signalk-distress-core');

// Pull the MMSI out of a SignalK vessel context, e.g.
// "vessels.urn:mrn:imo:mmsi:974321098" → "974321098". Non-MMSI contexts
// (uuid-identified targets) yield undefined.
function mmsiFromContext(context) {
  if (typeof context !== 'string') return undefined;
  const m = context.match(/mmsi:(\d+)$/);
  return m ? m[1] : undefined;
}

// 974 EPIRB / 972 MOB → a named nature of distress; 970 SART has no nature
// (it is a locating device), the deviceBeacon carries the meaning.
const BEACON_NATURE = { epirb: 'epirb', mob: 'mob' };

// Build a canonical AIS distress event from a position delta on a vessel
// context, or null if the context is not a 97x survival-beacon MMSI.
function buildBeaconEvent({ context, position, state, now }) {
  const mmsi = mmsiFromContext(context);
  const deviceBeacon = deviceBeaconFor(mmsi);
  if (!deviceBeacon) return null;
  return {
    source: 'ais',
    category: 'distress',
    deviceBeacon,
    mmsi,
    natureOfDistress: BEACON_NATURE[deviceBeacon],
    state,
    position,
    receivedAt: new Date(now).toISOString(),
  };
}

module.exports = { mmsiFromContext, buildBeaconEvent };
