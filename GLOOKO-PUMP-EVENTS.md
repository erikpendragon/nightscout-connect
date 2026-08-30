# nightscout-connect patches

Changes made to **nightscout-connect** (not Nightscout itself) to get Omnipod 5
pod/sensor/reservoir changes and pump alarms out of Glooko and into Nightscout.

`glooko-pump-events.patch` applies cleanly to a fresh checkout of
`nightscout/nightscout-connect` **main**. 190 changed lines across three files.

**Nightscout core is untouched.** Everything done there was environment
variables in `docker-compose.yml` — listed at the bottom so they can be
reproduced, but they are configuration, not code.

---

## What the patch does

### `lib/sources/glooko/index.js`

**Fetch pump events and alarms.** Adds `/api/v2/pumps/events` and
`/api/v2/pumps/alarms`, which upstream never requests. Both carry data Glooko
has always had — pod activations, reservoir changes, sensor changes, and the
pump's own alarm log.

⚠️ **They need their own query window.** The driver shares one `params` object
whose `lastUpdatedAt` is pinned near *now* and whose `limit` collapses to
roughly zero. Against these endpoints that returns an empty array, which looks
exactly like "no data". `eventsFetcher()` uses a separate 14-day window.

**DST-correct timestamps.** `CONNECT_GLOOKO_TIMEZONE` (e.g. `America/Toronto`)
drives a per-timestamp `moment-timezone` conversion. The existing
`CONNECT_GLOOKO_TIMEZONE_OFFSET` is a fixed hour offset that is right for half
the year and silently an hour wrong for the other half. The offset remains as a
fallback.

**Cursor fix.** `last_mills` tracked `last_known.entries`, which Dexcom Share
rewrites every five minutes — pinning the cursor to now and collapsing `limit`.
Now tracks `last_known.treatments`.

### `lib/sources/glooko/convert.js`

Maps Glooko's own event types onto Nightscout's:

| Glooko `type` | Nightscout eventType | feeds |
|---|---|---|
| `pod_activating` | `Site Change` | CAGE |
| `cgm_sensor_change` | `Sensor Start` | SAGE |
| `reservoir_change` | `Insulin Change` | IAGE |

Alarms become `Note` treatments — never `Announcement`, so Nightscout draws
them on the graph without raising notifications. `alarm_type` is always null in
Glooko's payload; the machine-readable code is in **`value`**
(`omnipod_exit_close_loop`, `dexcom_signal_loss`, …).

⚠️ Uses `eventTime`, not `created_at`. Nightscout only derives `mills` from the
former, and clients need `mills` to age a treatment.

### `commands/forever.js`

Builds the driver config through `driver.validate()` so `baseURL` is populated,
and raises the STOP timer from 5 minutes to 24 hours.

---

## Known limitation

Pump events and alarms are filtered against the same timestamp cursor as
treatments. Glooko's sync lag is ~40 minutes, so an alarm that fires *before* a
bolus but syncs *after* it will be skipped. The robust fix is to deduplicate on
Glooko's own `guid` rather than a timestamp — which is what Taylor's
independent `glooko-bridge` already does.

## Nightscout configuration (not code)

```yaml
BG_LOW: "55"            # mg/dL regardless of DISPLAY_UNITS
BG_TARGET_BOTTOM: "70"
BG_TARGET_TOP: "198"
BG_HIGH: "260"
SHOW_PLUGINS: careportal basal iob cob cage sage iage bolus dbsize
CAGE_INFO/WARN/URGENT: 60 / 68 / 72      # Omnipod 72h
IAGE_INFO/WARN/URGENT: 60 / 68 / 72
SAGE_INFO/WARN/URGENT: 216 / 236 / 240   # Dexcom G7 10 days
CONNECT_GLOOKO_TIMEZONE: America/Toronto
THEME: colors
```

⚠️ `SHOW_PLUGINS` is only a *default* for browsers that have never saved
settings. Once a browser saves any setting its local list wins permanently —
use **Settings → "Reset, and use defaults"** in each browser after changing it.
