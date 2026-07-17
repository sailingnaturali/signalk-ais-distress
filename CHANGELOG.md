# Changelog

All notable changes to `@sailingnaturali/signalk-ais-distress` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- AIS Msg-14 safety-broadcast severities now follow the SignalK spec thread's ITU
  priority → notification-zone mapping: **distress → `alarm`** (was `emergency`)
  and **urgency → `warn`** (was `alarm`); safety stays `alert`. Survival beacons
  (SART/MOB/EPIRB) and the source-vessel record stay at `emergency`.

### Added

- An AIS-MOB beacon also raises the flat legacy `notifications.mob` self-key
  (alongside the per-vessel record) so existing MOB subscribers keep firing until
  they migrate to the `received.*` scheme.
- Test tooling, mirroring `signalk-dsc`: `scripts/send-test-ais.js` builds a
  real `!AIVDM` type 1 position report from a 970/972/974 MMSI and fires it at
  the server's NMEA 0183 UDP input (`npm run send-test-ais`), and
  `scripts/clear-ais-alarm.js` clears active beacon/broadcast alarms
  (`npm run clear-ais`). README gains a "Trying it without a radio" section.

## [0.2.2]

### Fixed

- Relay (Msg 14) and beacon alarms share one event store but alarm on different
  notification paths. The restart reannounce ran the beacon notifier over the
  whole store, so on restart a stored relay was re-raised at
  `notifications.ais.distress.undefined` at emergency (routine relays included),
  while real relay alarms did not survive a restart at all. Reannounce now runs
  each notifier over only its own events.
- A relay alarm can now be cleared: a PUT to `notifications.ais.broadcast.<category>`
  drops the live alert and stamps the stored relay so a restart does not re-raise
  it (mirrors the beacon clear).

### Changed

- Recommend the companion [`signalk-dsc`](https://github.com/sailingnaturali/signalk-dsc)
  plugin via `signalk.recommends` — AIS finds the casualty, DSC alerts on the VHF
  Ch 70 call; the two share `signalk-distress-core`.

## [0.2.1]

### Added

- App Store screenshot (`signalk.screenshots`) of the plugin config panel, so the
  SignalK App Store shows what the plugin looks like (clears the plugin-ci warning).

## [0.2.0]

### Added

- Alarm on **AIS Msg 14 coast-station relay text** (NMEA 2000 PGN 129802). The
  broadcast is classified by its leading procedure word — MAYDAY/MAYDAY RELAY →
  emergency, PAN PAN → alarm, SÉCURITÉ/SECURITE → alert — and raised under
  `notifications.ais.broadcast.<category>`, with a forensic log and an optional
  ship's-log entry. Routine safety broadcasts are logged, never alarmed. Text
  has no position, so no chart marker. Requires
  `@sailingnaturali/signalk-distress-core@^0.4.0`.

## [0.1.2]

### Fixed

- A continuously-transmitting survival beacon no longer re-alarms every 5
  minutes and no longer defeats an operator's clear. Repeats now slide the
  dedupe window forward (via `signalk-distress-core` 0.3.0's `findRecent`
  fix), so one incident stays one stored event, alarmed once, and a cleared
  beacon stays silent for as long as it keeps transmitting.

### Changed

- Restart reannounce now uses `signalk-distress-core`'s shared
  `notifier.reannounce` (with a `prepare` hook that refreshes the spoken
  range/direction) instead of a duplicated inline loop.

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
