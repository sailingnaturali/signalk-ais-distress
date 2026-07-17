# signalk-ais-distress

Alert on **AIS distress beacons** — SART, MOB, and EPIRB survival devices — the
moment they start transmitting.

AIS-SART, AIS-MOB, and AIS-EPIRB locating beacons (MMSI prefixes `970`, `972`,
`974`) broadcast their GNSS position over AIS to every receiver in range.
SignalK decodes them into vessel targets, but nothing flags them — an active
survival beacon just appears as another boat on the chart. This plugin watches
the position stream and turns a beacon into a real emergency.

For every 97x beacon heard, it:

- raises a per-call `notifications.received.distress.ais-<id>` under *self* at **emergency**, so the vessel's own alarm chain fires (two concurrent beacons never overwrite one alarm);
- serves the beacon history at `/signalk/v2/api/resources/ais-distress`;
- serves a chart-marker layer at `/signalk/v2/api/resources/ais-distress-markers`;
- keeps an on-disk JSONL forensic log;
- optionally writes a GMDSS-style ship's-log entry via [`signalk-logbook`](https://github.com/meri-imperiumi/signalk-logbook).

A beacon repeats its position several times a minute; repeats within a 5-minute
window update the stored event instead of re-alarming. Active beacons
re-announce after a server restart. A PUT to the notification path clears the
alarm.

## Why AIS, not just DSC

DSC distress (VHF Ch 70) is an *alerting* signal — see the companion
[`signalk-dsc`](https://github.com/sailingnaturali/signalk-dsc). AIS beacons are
about *finding* the casualty: a position stream you can home on. They share the
same 97x identity classes, and both are built on
[`@sailingnaturali/signalk-distress-core`](https://github.com/sailingnaturali/signalk-distress-core).

## Trying it without a radio

### Quick test script

The repo includes a script that builds a real AIS position report (message
type 1, `!AIVDM`) from a survival-beacon MMSI and fires it at the server over
UDP. First add a UDP input in your SignalK pipedProviders (Settings →
Connections → Add):

```json
{
  "id": "ais-test-udp",
  "pipeElements": [{ "type": "providers/simple",
    "options": { "type": "NMEA0183", "subOptions": { "type": "udp", "port": "7777" } } }]
}
```

Then send a fake beacon:

```bash
# Default: active SART, MMSI 970123456, near Boundary Pass → naturalaspi:7777
node scripts/send-test-ais.js

# npm alias
npm run send-test-ais

# Different beacon class (sets the MMSI prefix: 970 sart, 972 mob, 974 epirb)
node scripts/send-test-ais.js --beacon mob
node scripts/send-test-ais.js --beacon epirb

# Specific MMSI / position
node scripts/send-test-ais.js --mmsi 974321098 --lat 48.9 --lon -123.5

# Different host / port
node scripts/send-test-ais.js --host localhost --port 7777
```

Verify the beacon was captured:

```
GET /signalk/v2/api/resources/ais-distress
```

### Clearing an alarm

A heard beacon raises a per-call `notifications.received.distress.ais-<id>` at
emergency, re-raised for up to an hour across server restarts. Acknowledge one
alarm by PUTting its own path — what a chartplotter does when you clear the
alarm it is showing. To bulk-clear every active alarm of a beacon type from the
CLI — dropping the live notifications and stopping the restart re-raise:

```bash
SIGNALK_TOKEN=<readwrite-token> npm run clear-ais -- --beacon sart
```

`--beacon all` (the default) clears all three. A Msg 14 relay alarm clears with
`--broadcast <distress|urgency|safety|all>` instead. Clearing is a write, so it
needs a readwrite token. A new incoming beacon still alarms normally.

## License

MIT
