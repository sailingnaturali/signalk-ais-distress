#!/usr/bin/env node
'use strict';

/*
 * clear-ais-alarm.js — clear an active AIS distress alarm on a SignalK server.
 *
 * Clearing is a write, so it needs a readwrite token (the same SIGNALK_TOKEN
 * that fires a test MOB). It drops the live notification AND marks the stored
 * beacon so a server restart will not re-raise it.
 *
 * Usage:
 *   node scripts/clear-ais-alarm.js [options]
 *   SIGNALK_TOKEN=... npm run clear-ais -- --beacon sart
 *
 * Options:
 *   --host <host>       SignalK HTTP host (default: naturalaspi.local)
 *   --port <port>       SignalK HTTP port (default: 3000)
 *   --beacon <type>     sart | mob | epirb | all (default: all)
 *   --broadcast <cat>   distress | urgency | safety | all — clear a Msg 14
 *                       relay alarm instead of a beacon alarm
 *   --token <jwt>       Readwrite token (default: $SIGNALK_TOKEN)
 *
 * Examples:
 *   node scripts/clear-ais-alarm.js
 *   node scripts/clear-ais-alarm.js --beacon mob
 *   node scripts/clear-ais-alarm.js --broadcast urgency
 *   node scripts/clear-ais-alarm.js --host localhost --beacon sart
 */

const http = require('node:http');

const BEACONS = ['sart', 'mob', 'epirb'];
const BROADCASTS = ['distress', 'urgency', 'safety'];

function parseArgs(argv) {
  const args = {
    host: 'naturalaspi.local',
    port: 3000,
    beacon: null,
    broadcast: null,
    token: process.env.SIGNALK_TOKEN || '',
  };
  // Flag/value pairs; unknown or valueless flags are silently ignored.
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i], val = argv[i + 1];
    if (flag === '--host')      args.host = val;
    if (flag === '--port')      args.port = Number(val);
    if (flag === '--beacon')    args.beacon = val;
    if (flag === '--broadcast') args.broadcast = val;
    if (flag === '--token')     args.token = val;
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    console.error(`Invalid --port "${args.port}". Must be a positive integer.`);
    process.exit(1);
  }
  return args;
}

function clear(notificationPath, { host, port, token }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ value: null });
    // Clearing goes through the SignalK REST API (HTTP :3000), not the UDP
    // injection port the send-test-ais script uses — it is an authed write.
    const req = http.request(
      {
        host,
        port,
        method: 'PUT',
        path: `/signalk/v1/api/vessels/self/notifications/${notificationPath}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function resolveTargets({ beacon, broadcast }) {
  if (broadcast) {
    if (broadcast !== 'all' && !BROADCASTS.includes(broadcast)) {
      console.error(`Unknown broadcast "${broadcast}". Valid: ${BROADCASTS.join(', ')}, all`);
      process.exit(1);
    }
    const cats = broadcast === 'all' ? BROADCASTS : [broadcast];
    return cats.map((c) => `ais/broadcast/${c}`);
  }
  const b = beacon || 'all';
  if (b !== 'all' && !BEACONS.includes(b)) {
    console.error(`Unknown beacon "${b}". Valid: ${BEACONS.join(', ')}, all`);
    process.exit(1);
  }
  const beacons = b === 'all' ? BEACONS : [b];
  return beacons.map((t) => `ais/distress/${t}`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.token) {
    console.error('No token. Pass --token <jwt> or set SIGNALK_TOKEN (a readwrite token).');
    process.exit(1);
  }

  const targets = resolveTargets(args);
  let failed = false;
  for (const target of targets) {
    const { status, body } = await clear(target, args);
    const ok = status >= 200 && status < 300;
    console.log(`${ok ? 'cleared' : 'FAILED'} ${target} → HTTP ${status} ${body}`);
    if (!ok) failed = true;
  }
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
