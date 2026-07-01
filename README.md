# signalk-ais-distress

Alert on **AIS distress beacons** — SART, MOB, and EPIRB survival devices — the
moment they start transmitting.

AIS-SART, AIS-MOB, and AIS-EPIRB locating beacons (MMSI prefixes `970`, `972`,
`974`) broadcast their GNSS position over AIS to every receiver in range.
SignalK decodes them into vessel targets, but nothing flags them — an active
survival beacon just appears as another boat on the chart. This plugin watches
the position stream and turns a beacon into a real emergency.

For every 97x beacon heard, it:

- raises `notifications.ais.distress.<sart|mob|epirb>` under *self* at **emergency**, so the vessel's own alarm chain fires;
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

## License

MIT
