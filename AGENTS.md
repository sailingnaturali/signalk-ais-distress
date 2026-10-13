# AGENTS.md — signalk-ais-distress

SignalK Node Server plugin. Alerts on AIS survival beacons (SART/MOB/EPIRB, MMSI 970/972/974) and AIS Msg 14 safety broadcasts. Built on `@sailingnaturali/signalk-distress-core`.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (`node --test`) |
| `npm run send-test-ais` | Fire a synthetic AIS beacon at UDP `naturalaspi:7777` (or `--host/--port`) |
| `npm run clear-ais -- --beacon sart` | Bulk-clear active beacon alarms via HTTP PUT; needs `SIGNALK_TOKEN` (readwrite) |

## Test without a radio

```bash
# Add UDP input in SignalK: pipedProviders → simple NMEA0183 UDP port 7777
npm run send-test-ais              # default: SART at 48.75, -123.25
npm run send-test-ais -- --beacon mob
npm run send-test-ais -- --beacon epirb
# Verify:
curl http://localhost:3000/signalk/v2/api/resources/ais-distress
```

Clearing is a write — always needs a readwrite token:
```bash
SIGNALK_TOKEN=<jwt> npm run clear-ais -- --beacon all
SIGNALK_TOKEN=<jwt> npm run clear-ais -- --broadcast distress
```

## Architecture (what you'd miss from filenames)

- **Entry**: `index.js` exports `makePlugin(app)` — SignalK calls this.
- **EventStore** (from distress-core) persists to `ais-distress.jsonl` in SignalK's data dir.
- **Position stream**: subscribes to `app.streambundle.getBus('navigation.position')`. Guards against missing stream (plugin-ci, minimal app) — logs error, continues.
- **N2K PGN 129802**: listens on `app.on('N2KAnalyzerOut')` for AIS Msg 14 safety broadcasts.
- **Two notifiers** share one `EventStore`:
  - `notifier` → beacon alarms at `notifications.received.distress.ais-<id>` (always `emergency`)
  - `broadcastNotifier` → relay alarms at `notifications.received.<category>.ais-<id>` (`distress`→`emergency`, `urgency`→`alarm`, `safety`→`warn`)
- **Per-vessel emission**: MOB → `notifications.mob` in vessel context; SART/EPIRB → `notifications.distress`. Plus legacy flat `notifications.mob` self-key for MOB.
- **Dedupe**: 5-minute window by MMSI (beacons) or MMSI+text (relays). Repeats slide the window, never re-alarm.
- **Reannounce on restart**: 30s delay, 1-hour window. Each notifier runs over only its own `kind` events (bugfix: cross-contamination fixed in 0.2.2).
- **Resource providers**: `ais-distress` (history) and `ais-distress-markers` (chart layer, bucketed by device).
- **Optional logbook**: writes via `signalk-logbook` if `logbookToken` configured.

## Logbook integration (signalk-logbook v2 Resources API)

Prefers the SignalK v2 Resources API (`app.resourcesApi.setResource`) over the legacy
plugin REST API — no separate URL or cookie handling when the SignalK app provides
`resourcesApi`.

- **Default**: v2 Resources API (`/signalk/v2/api/resources/logentries`) — needs only a
  `logbookToken` (readwrite). Payload uses `uuid`, `origin: 'auto'`, `category: 'radio'`.
- **Fallback**: if `resourcesApi` is unavailable and `logbookUrl` is set, falls back to
  the v1 REST API with Bearer + `JAUTHENTICATION` cookie (backward compat).
- **Disabled by default in tests**: `logbookToken` empty in `mockApp()` → `shouldLogbook()`
  returns false → no writes attempted.
- **Errors**: logged via `app.error()` with the HTTP status or writer-missing reason.

## Key files

```
index.js                 # plugin factory, start/stop, notifiers, resource providers
lib/detect.js            # extract MMSI from context, build beacon event (970/972/974)
lib/classify.js          # classify Msg 14 text: MAYDAY→distress, PAN PAN→urgency, SECURITE→safety
lib/pgn129802.js         # normalize canboatjs PGN 129802 fields → canonical event
scripts/send-test-ais.js # builds real !AIVDM type 1 from 97x MMSI, sends UDP
scripts/clear-ais-alarm.js # PUTs notification path to clear alarm + stamp stored event
```

## Test notes

- Uses Node's built-in `node:test` (no Jest/Vitest).
- `test/plugin.test.js` mocks a full SignalK `app` object — read `mockApp()` for the contract.
- `reannounceDelayMs: 1e9` disables the timer; `reannounceDelayMs: 0` fires immediately (test seam, schema-hidden).
- Run single test file: `node --test test/plugin.test.js`

## Gotchas

- **Never activate a real SART/MOB/EPIRB to test** — launches real SAR. README has a `WARNING` box.
- `start()` degrades gracefully if `app.streambundle` missing (plugin-ci harness).
- `npm run clear-ais` hits HTTP `:3000` (REST API), not the UDP injection port.
- Beacon MMSI prefixes are ITU-R M.585: `970` SART, `972` MOB, `974` EPIRB.
- Chart markers only for position-bearing beacons; text-only relays (Msg 14) never appear there.
