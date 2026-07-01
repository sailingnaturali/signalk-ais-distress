'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../lib/classify');

test('leading MAYDAY / MAYDAY RELAY is distress, case- and whitespace-insensitive', () => {
  assert.equal(classify('MAYDAY RELAY MAYDAY RELAY, all ships…'), 'distress');
  assert.equal(classify('MAYDAY, sinking vessel'), 'distress');
  assert.equal(classify('  mayday relay '), 'distress');
});

test('PAN PAN (and PAN-PAN) is urgency', () => {
  assert.equal(classify('PAN PAN, disabled vessel drifting'), 'urgency');
  assert.equal(classify('PAN-PAN medico'), 'urgency');
});

test('SECURITE / SÉCURITÉ is safety', () => {
  assert.equal(classify('SECURITE navigation warning'), 'safety');
  assert.equal(classify('SÉCURITÉ, buoy adrift'), 'safety');
});

test('anything without a leading procedure word is routine', () => {
  assert.equal(classify('Navigation warning: buoy 42 unlit'), 'routine');
  assert.equal(classify('AIS test message'), 'routine');
  assert.equal(classify(''), 'routine');
  assert.equal(classify(undefined), 'routine');
});
