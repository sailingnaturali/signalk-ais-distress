'use strict';

// PGN 129802 "AIS Safety Related Broadcast Message" → canonical event. canboatjs
// (camelCompat) field names vary by decode path; accept the common aliases.
// Classification is applied by the caller (lib/classify), keeping this a pure
// decoder.
function normalizeMmsi(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const digits = String(value).trim();
  if (!/^\d{1,9}$/.test(digits)) return undefined;
  if (Number(digits) === 0) return undefined;
  return digits.padStart(9, '0');
}

function normalizePgn129802(pgnData) {
  const f = (pgnData && pgnData.fields) || {};
  const text = (f.safetyRelatedText ?? f.safetyText ?? f['Safety Related Text'] ?? '')
    .toString()
    .trim();
  if (!text) return null;
  return {
    source: 'ais',
    kind: 'safetyBroadcast',
    mmsi: normalizeMmsi(f.sourceId ?? f.sourceMmsi ?? f.userId ?? f['Source ID']),
    text,
  };
}

module.exports = { normalizePgn129802 };
