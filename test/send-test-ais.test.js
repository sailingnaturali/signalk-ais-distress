'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildSentence } = require('../scripts/send-test-ais.js');

/*
 * Independent AIVDM decoder — deliberately written from ITU-R M.1371, not by
 * inverting the encoder, so an encoder bit-packing bug cannot cancel out.
 */

function deArmor(payload) {
  let bits = '';
  for (const c of payload) {
    let v = c.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    bits += v.toString(2).padStart(6, '0');
  }
  return bits;
}

function uint(bits, start, len) {
  return parseInt(bits.slice(start, start + len), 2);
}

function sint(bits, start, len) {
  const raw = uint(bits, start, len);
  return bits[start] === '1' ? raw - 2 ** len : raw;
}

function decode(sentence) {
  const m = sentence.match(/^!AIVDM,(\d),(\d),,([AB]),([^,]+),(\d)\*([0-9A-F]{2})$/);
  assert.ok(m, `sentence shape: ${sentence}`);
  const [, fragments, fragmentNo, , payload, fillBits, checksum] = m;

  let cksum = 0;
  for (const c of sentence.slice(1, sentence.indexOf('*'))) cksum ^= c.charCodeAt(0);

  const bits = deArmor(payload);
  return {
    fragments: Number(fragments),
    fragmentNo: Number(fragmentNo),
    payload,
    fillBits: Number(fillBits),
    checksumOk: cksum.toString(16).toUpperCase().padStart(2, '0') === checksum,
    bitLength: bits.length,
    type: uint(bits, 0, 6),
    mmsi: String(uint(bits, 8, 30)).padStart(9, '0'),
    navStatus: uint(bits, 38, 4),
    lon: sint(bits, 61, 28) / 600000,
    lat: sint(bits, 89, 27) / 600000,
  };
}

test('builds a single-fragment 168-bit AIVDM type 1 sentence with a valid checksum', () => {
  const d = decode(buildSentence({ mmsi: '970123456', lat: 48.75, lon: -123.25 }));
  assert.strictEqual(d.fragments, 1);
  assert.strictEqual(d.fragmentNo, 1);
  assert.strictEqual(d.payload.length, 28);
  assert.strictEqual(d.fillBits, 0);
  assert.strictEqual(d.bitLength, 168);
  assert.strictEqual(d.type, 1);
  assert.ok(d.checksumOk, 'NMEA checksum must validate');
});

test('encodes the beacon MMSI and nav status 14 (AIS-SART active)', () => {
  const d = decode(buildSentence({ mmsi: '972109876', lat: 48.75, lon: -123.25 }));
  assert.strictEqual(d.mmsi, '972109876');
  assert.strictEqual(d.navStatus, 14);
});

test('encodes a NW-hemisphere position to within AIS resolution', () => {
  const d = decode(buildSentence({ mmsi: '970123456', lat: 48.7601, lon: -123.1002 }));
  assert.ok(Math.abs(d.lat - 48.7601) < 1e-5, `lat ${d.lat}`);
  assert.ok(Math.abs(d.lon - -123.1002) < 1e-5, `lon ${d.lon}`);
});

test('encodes a SE-hemisphere position (negative lat, positive lon)', () => {
  const d = decode(buildSentence({ mmsi: '974555000', lat: -41.29, lon: 174.78 }));
  assert.ok(Math.abs(d.lat - -41.29) < 1e-5, `lat ${d.lat}`);
  assert.ok(Math.abs(d.lon - 174.78) < 1e-5, `lon ${d.lon}`);
});
