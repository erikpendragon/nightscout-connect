# Glooko: pump events, alarms and guid deduplication

Gets Omnipod 5 pod, sensor and reservoir changes, plus the pump's own alarm log,
out of Glooko and into Nightscout — so the `cage`, `sage` and `iage` plugins
populate from the pump's own record instead of needing someone to log changes by
hand in careportal.

Nightscout core is untouched; this is entirely within the Glooko source driver,
the converter and the Nightscout output. Enabling the resulting plugins is
ordinary Nightscout configuration and is out of scope here.

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

**DST-correct timestamps.** `CONNECT_GLOOKO_TIMEZONE` (e.g. `Europe/Prague`)
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

## Deduplication

Pump events and alarms are deduplicated on **Glooko's own `guid`**, not on a
timestamp. Glooko's sync lag is around 40 minutes, so an event can arrive after
a bolus that happened later than it — against a time cursor that event falls
behind the mark and is skipped for good.

Each generated treatment carries `glookoGuid`. The output layer seeds the known
set from Nightscout at startup (45-day window) and adds to it as it posts, so a
restart does not re-import everything inside the fetch window.

Measured on a live instance: the first run after adopting this imported 80
treatments (nothing carried a guid yet), the next run seeded 74 guids and
imported 6, and the one after that imported 1 — a genuinely new bolus.

⚠️ Event types the converter does not map — `prime_cannula`, `prime_tubing`,
`pod_deactivated`, `pod_discarded` — are never stored, so they never enter the
guid set and are re-examined every cycle. They produce no treatments, so this
is log noise rather than a correctness problem.

## Note on enabling the plugins

The wear-time plugins (`cage`, `sage`, `iage`) have to be in both `ENABLE` and
`SHOW_PLUGINS`, and pod/sensor lifetimes differ from Nightscout's defaults — an
Omnipod runs 72 h against a default that assumes a 3-day infusion set, and a
Dexcom G7 runs 10 days against a default that assumes a 7-day G6.

`SHOW_PLUGINS` is only a *default* for browsers that have never saved settings.
Once a browser saves any setting its local list wins permanently — use
**Settings -> "Reset, and use defaults"** in that browser after changing it.
