# Changelog

All notable changes to `@sailingnaturali/signalk-ais-distress` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]

### Added

- SignalK plugin-ci workflow (cross-platform validation; +10 on the plugin registry).

### Fixed

- `start()` no longer throws when the position stream is unavailable (e.g. under
  SignalK's plugin-ci validation harness, or a server without `streambundle`) — it
  logs a clear error and registers its resources anyway instead of failing to load.

## [0.1.0]

### Added

- Monitor AIS survival beacons (SART / MOB / EPIRB, MMSI 970/972/974) off the
  `navigation.position` stream: raise `notifications.ais.distress.<beacon>` at
  emergency under self, serve a beacon history at `/resources/ais-distress` and
  a chart-marker layer at `/resources/ais-distress-markers`, keep a JSONL
  forensic log, and optionally write a ship's-log entry via signalk-logbook.
- Repeats within a 5-minute window update the stored beacon instead of
  re-alarming; active beacons re-announce after a server restart. A PUT to the
  notification path clears the alarm.
- Built on `@sailingnaturali/signalk-distress-core`.
