#!/usr/bin/env node
'use strict';

/*
 * send-test-ais.js — inject a fake AIS survival beacon into a SignalK server via UDP.
 *
 * Builds an AIS message type 1 (position report) from a 97x MMSI, armors it as
 * an !AIVDM sentence, and fires it at the server's NMEA 0183 UDP input. The
 * server's AIS parser creates the beacon as a vessel target, and
 * signalk-ais-distress alarms on the 970/972/974 MMSI prefix.
 *
 * Usage:
 *   node scripts/send-test-ais.js [options]
 *
 * Options:
 *   --host <host>      UDP target host (default: naturalaspi)
 *   --port <port>      UDP target port (default: 7777)
 *   --beacon <type>    sart | mob | epirb — picks the default MMSI prefix
 *                      (default: sart)
 *   --mmsi <mmsi>      9-digit beacon MMSI, overrides --beacon's default
 *                      (970/972/974 prefix, or the plugin will ignore it)
 *   --lat <deg>        Latitude in decimal degrees, positive = N (default: 48.75)
 *   --lon <deg>        Longitude in decimal degrees, negative = W (default: -123.25)
 *
 * Examples:
 *   node scripts/send-test-ais.js
 *   node scripts/send-test-ais.js --beacon mob
 *   node scripts/send-test-ais.js --mmsi 974321098 --lat 48.9 --lon -123.5
 *   node scripts/send-test-ais.js --host localhost --port 7777
 */

const dgram = require('node:dgram');

// Survival-beacon MMSI prefixes (ITU-R M.585): 970 SART, 972 MOB, 974 EPIRB.
const BEACON_MMSI = {
  sart: '970123456',
  mob: '972123456',
  epirb: '974123456',
};

// Navigation status 14 = "AIS-SART is active" — what a real survival beacon
// transmits in its type 1 position reports (ITU-R M.1371 Table 45).
const NAV_STATUS_SART_ACTIVE = 14;

function parseArgs(argv) {
  const args = { host: 'naturalaspi', port: 7777, beacon: 'sart',
                 mmsi: null, lat: 48.75, lon: -123.25 };
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i], val = argv[i + 1];
    if (flag === '--host')   args.host = val;
    if (flag === '--port')   args.port = Number(val);
    if (flag === '--beacon') args.beacon = val;
    if (flag === '--mmsi')   args.mmsi = val;
    if (flag === '--lat')    args.lat = parseFloat(val);
    if (flag === '--lon')    args.lon = parseFloat(val);
  }
  return args;
}

/*
 * Bit-pack an AIS message type 1 (168 bits, ITU-R M.1371 §3.3.8.2.1).
 * Unavailable fields carry their spec "not available" values: ROT 128,
 * COG 3600, heading 511, timestamp 60. SOG 0 — a beacon drifts.
 */
function packType1({ mmsi, lat, lon }) {
  let bits = '';
  const put = (value, len) => {
    const v = value < 0 ? value + 2 ** len : value; // two's complement
    bits += v.toString(2).padStart(len, '0');
  };

  put(1, 6);                              // message type
  put(0, 2);                              // repeat indicator
  put(Number(mmsi), 30);                  // MMSI
  put(NAV_STATUS_SART_ACTIVE, 4);         // navigation status
  put(128, 8);                            // rate of turn: not available
  put(0, 10);                             // SOG: 0 kn
  put(1, 1);                              // position accuracy: high
  put(Math.round(lon * 600000), 28);      // longitude, 1/10000 min
  put(Math.round(lat * 600000), 27);      // latitude, 1/10000 min
  put(3600, 12);                          // COG: not available
  put(511, 9);                            // true heading: not available
  put(60, 6);                             // UTC second: not available
  put(0, 2);                              // maneuver indicator
  put(0, 3);                              // spare
  put(0, 1);                              // RAIM
  put(0, 19);                             // radio status
  return bits;                            // 168 bits = 28 armored chars, 0 fill
}

// 6-bit ASCII armoring (ITU-R M.1371 Table 46): 0–39 → '0'.., 40–63 → '`'..
function armor(bits) {
  let payload = '';
  for (let i = 0; i < bits.length; i += 6) {
    const v = parseInt(bits.slice(i, i + 6), 2);
    payload += String.fromCharCode(v < 40 ? v + 48 : v + 56);
  }
  return payload;
}

function nmeaChecksum(body) {
  let cksum = 0;
  for (const c of body) cksum ^= c.charCodeAt(0);
  return cksum.toString(16).toUpperCase().padStart(2, '0');
}

function buildSentence({ mmsi, lat, lon }) {
  const payload = armor(packType1({ mmsi, lat, lon }));
  const body = `AIVDM,1,1,,A,${payload},0`;
  return `!${body}*${nmeaChecksum(body)}`;
}

function send(sentence, host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const buf = Buffer.from(sentence + '\r\n');
    sock.send(buf, port, host, (err) => {
      sock.close();
      if (err) reject(err); else resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!BEACON_MMSI[args.beacon]) {
    console.error(`Unknown beacon "${args.beacon}". Valid: ${Object.keys(BEACON_MMSI).join(', ')}`);
    process.exit(1);
  }
  const mmsi = args.mmsi || BEACON_MMSI[args.beacon];
  if (!/^\d{9}$/.test(mmsi)) {
    console.error(`Invalid MMSI "${mmsi}". Must be 9 digits.`);
    process.exit(1);
  }

  const sentence = buildSentence({ mmsi, lat: args.lat, lon: args.lon });
  console.log(`Sending: ${sentence}`);
  console.log(`         (${args.beacon.toUpperCase()} beacon, MMSI ${mmsi}, ${args.lat}, ${args.lon})`);
  console.log(`     to: udp://${args.host}:${args.port}`);

  await send(sentence, args.host, args.port);
  console.log('Sent. Check /signalk/v2/api/resources/ais-distress on the server.');
}

module.exports = { buildSentence };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
