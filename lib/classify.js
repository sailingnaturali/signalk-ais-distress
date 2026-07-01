'use strict';

// Classify an AIS Msg 14 safety-related broadcast by its leading procedure word.
// A coast/ship station leads a relay with the spoken procedure word; that word
// is the reliable severity signal in otherwise free text. No word → routine.
function classify(text) {
  const t = typeof text === 'string' ? text.replace(/^\s+/, '') : '';
  if (/^MAYDAY(\s+RELAY)?\b/i.test(t)) return 'distress';
  if (/^PAN[\s-]?PAN\b/i.test(t)) return 'urgency';
  if (/^S[EÉ]CURIT[EÉ]/i.test(t)) return 'safety';
  return 'routine';
}

module.exports = { classify };
