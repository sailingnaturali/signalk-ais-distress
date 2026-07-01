'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePgn129802 } = require('../lib/pgn129802');

test('decodes sender MMSI and text from a canboatjs-shaped PGN 129802', () => {
  const ev = normalizePgn129802({
    pgn: 129802,
    fields: { sourceId: 3160001, safetyRelatedText: 'MAYDAY RELAY, sailing vessel Blue Heron' },
  });
  assert.equal(ev.source, 'ais');
  assert.equal(ev.kind, 'safetyBroadcast');
  assert.equal(ev.mmsi, '003160001');
  assert.equal(ev.text, 'MAYDAY RELAY, sailing vessel Blue Heron');
});

test('accepts field-name aliases and trims the text', () => {
  const ev = normalizePgn129802({ pgn: 129802, fields: { userId: 366999707, safetyText: '  PAN PAN  ' } });
  assert.equal(ev.mmsi, '366999707');
  assert.equal(ev.text, 'PAN PAN');
});

test('returns null when there is no usable text', () => {
  assert.equal(normalizePgn129802({ pgn: 129802, fields: { sourceId: 3160001, safetyRelatedText: '' } }), null);
  assert.equal(normalizePgn129802({ pgn: 129802, fields: {} }), null);
  assert.equal(normalizePgn129802({}), null);
});
