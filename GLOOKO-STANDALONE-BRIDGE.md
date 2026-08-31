# Glooko → Nightscout: standalone bridge notes

Reference notes on an **independent** Glooko → Nightscout treatment bridge that
runs *beside* Nightscout instead of inside `nightscout-connect`. It was written
for one real deployment and is captured here because it reaches several of the
same conclusions as the `GLOOKO-PUMP-EVENTS.md` patch by a different route, and
because the shape of its output is deliberately compatible with that patch.

Nothing here is a patch to this repo's code. It is a description of a separate
implementation, framed against `lib/sources/glooko/` on **main** so the
differences are legible.

---

## 1. Shape / integration

| | stock `lib/sources/glooko` | standalone bridge |
|---|---|---|
| runs | in-process, as a `nightscout-connect` source (itself a Nightscout plugin) | own OS process / own container |
| language | Node, `axios` + `xstate` state machines, backoff, session-refresh timers | Python 3, standard library only (`urllib`, `http.cookiejar`, `zoneinfo`, `hashlib`) |
| writes to Nightscout | `lib/outputs/nightscout.js` (internal call or HTTP), keeps a per-type `bookmark` | HTTP REST only: `POST /api/v1/treatments`, `POST /api/v1/devicestatus` |
| reads from Nightscout | yes — GETs treatments/profile/entries to seed cursors | **never** — write-only |
| lifecycle coupling | tied to the Nightscout process | fully decoupled; a Nightscout image bump cannot break Glooko ingest and vice-versa |
| loop | poller machine, `expected_data_interval_ms` | `while True: run_once(); sleep(INTERVAL_MIN*60)` |
| session | authenticate once, refresh on a ~24 h timer | fresh login every cycle |

The published npm release the deployment actually runs (`nightscout-connect@0.0.12`,
pulled in transitively by `cgm-remote-monitor`) has **no Glooko source at all**
— `lib/sources/` there is `dexcomshare`, `librelinkup`, `nightscout`. So in that
install the bridge *is* the entire Glooko treatment path; CGM/`sgv` is handled by
a separate source and is out of scope for the bridge.

---

## 2. Authentication

Stock supports three modes — `api` (JSON `POST /api/v2/users/sign_in` with a
synthetic `deviceInformation` block), `web` (scrape `authenticity_token`, form
`POST`), and `auto` (api, fall back to web on HTTP 422) — plus 2FA detection.

The bridge implements **only the web-form CSRF flow**, because the JSON endpoint
rejects otherwise-valid credentials for this account
(`nightscout/nightscout-connect#14`):

1. `GET /users/sign_in` → regex out `name="authenticity_token" value="…"`
2. `POST` url-encoded `utf8=✓ / authenticity_token / user[email] / user[password] / commit=Log in`
3. failure detected by the response URL still containing `sign_in`

Cookie handling is a stdlib `CookieJar` on a `build_opener`. Same fixed browser
`User-Agent` string upstream uses. No retry/backoff around auth — a failed cycle
just logs and waits for the next one.

---

## 3. Endpoints called (Glooko side)

| endpoint | stock `main` | fork patch | standalone bridge |
|---|---|---|---|
| `/api/v2/pumps/normal_boluses` | ✔ | ✔ (+ wide window) | ✔ |
| `/api/v2/pumps/scheduled_basals` | ✔ | ✔ (+ wide window) | — |
| `/api/v2/cgm/readings` | ✔ | ✔ | — (CGM handled elsewhere) |
| `/api/v3/graph/data` (+ `/api/v3/session/users`) | ✔ fallback | ✔ | — |
| `/api/v2/foods` | defined, commented out | ✔ | ✔ |
| `/api/v2/insulins` | defined, commented out | — | ✔ |
| `/api/v2/pumps/events` | — | ✔ | — |
| `/api/v2/pumps/alarms` | — | ✔ | — |

Query string per request: `lastUpdatedAt=<UTC-midnight, now − LOOKBACK_DAYS>` +
`lastGuid=<constant>` + `limit=500`, identical for all three endpoints — no
`patient=` param, no per-endpoint window. The `lastGuid` value is the **same
throwaway constant hard-coded in this repo's `Defaults.lastGuid`**; its purpose
is equally undocumented here. The lower bound is snapped to UTC midnight on
purpose, so DST/tz slop near the boundary can't drop an event.

The bridge does **not** contact Nightscout for reads, does not use the v3 graph,
and does not fetch basals, CGM, pump events or alarms.

---

## 4. Glooko type → Nightscout `eventType` mapping

| Glooko record | condition | `eventType` | fields written |
|---|---|---|---|
| `normalBoluses[]` | `carbsInput > 0` | `Meal Bolus` | `insulin`, `carbs` |
| `normalBoluses[]` | `carbsInput == 0`, insulin present | `Correction Bolus` | `insulin` |
| `normalBoluses[].insulinOnBoard` | present | *(not a treatment)* → `POST /api/v1/devicestatus` `pump.iob.iob`, `device: "glooko-bridge (<pump model>)"` | — |
| `foods[]` | carb value present | `Carb Correction` | `carbs` |
| `insulins[]` | dose value present | `Correction Bolus` | `insulin` |

Every treatment also carries `enteredBy: "glooko-bridge"` and
`glookoGuid: <Glooko guid>`. Insulin values are rounded to 2 dp, carbs to 1 dp.

Differences from stock `convert.js` worth naming:

- **Bolus class is derived, not fixed.** Stock labels *every* pump bolus
  `Meal Bolus`; the bridge splits `Meal` vs `Correction` on `carbsInput`.
- **`foods[]` → `Carb Correction` unconditionally.** No food/insulin
  correlation window, no `preBolus` calculation (stock pairs a food with an
  `insulins[]` entry within ±46 min and promotes it to `Meal Bolus`).
- **`insulins[]` → `Correction Bolus` unconditionally.** Stock suppresses the
  manual-insulin entry when a nearby food exists; the bridge does not
  de-duplicate across the two Glooko record types.
- **IOB is surfaced.** Stock's Glooko path never writes `devicestatus`; pump
  IOB is dropped. The bridge posts it so the pill / IOB plugin has a value.
- **No `notes` field is ever set.** Stock does `notes: JSON.stringify(element)`
  — the entire raw Glooko record, including its embedded identifiers and
  timestamps, lands in the treatment note. The bridge writes no note at all.
- **Timestamp key is `created_at`**, not `eventTime`. (The v1 treatments API
  accepts either and derives `mills` from `created_at` when `eventTime` is
  absent. `GLOOKO-PUMP-EVENTS.md` argues for `eventTime`; noted as a known
  divergence.)
- No basal, temp-basal, pod/sensor/reservoir, or alarm handling.

---

## 5. Deduplication

**Client-side only, keyed on Glooko's own `guid`.** A set of seen guids is
persisted to a JSON file on a dedicated volume and rewritten after every cycle.
Before posting: `if guid in seen: skip`. Records the bridge deliberately drops
(e.g. a bolus with neither carbs nor insulin) are still added to the set so they
aren't re-examined next cycle.

- **Plus:** guid-exact, so it is immune to the time-cursor skew that
  `GLOOKO-PUMP-EVENTS.md` documents (an event that syncs after a later bolus
  falling behind a timestamp mark and being lost).
- **Minus:** the state lives *outside* Nightscout. If the volume is lost, every
  record in the `LOOKBACK_DAYS` window is re-`POST`ed, and Nightscout keeps the
  duplicates — there is no unique index on `glookoGuid` and the bridge sets no
  Nightscout `identifier`, so nothing rejects them.

Because every treatment carries `glookoGuid` (same field name and semantics the
fork patch uses), a consumer *could* seed the set from
`GET /api/v1/treatments` the way `lib/outputs/nightscout.js` does in the patch.
The bridge simply doesn't — its dedup is entirely local. The two
implementations are wire-compatible on that field.

---

## 6. Timezone handling

Glooko stamps **pump-local wall-clock** time and suffixes it with a literal
`Z`; `pumpTimestampUtcOffset` is reported as `+00:00` regardless. Converting as
if it were UTC is an hour wrong for half the year.

- **Stock `main`:** `timestampWithOffset()` adds a **fixed** millisecond offset
  from `CONNECT_GLOOKO_TIMEZONE_OFFSET` (hours). Correct only outside DST — the
  exact issue `GLOOKO-PUMP-EVENTS.md` fixes with `CONNECT_GLOOKO_TIMEZONE` +
  `moment-timezone`.
- **Bridge:** parses the first 19 chars as naive local time, attaches an IANA
  zone via stdlib **`zoneinfo`**, converts to real UTC, re-emits `…000Z`. DST
  comes from the tz database. Zone is set by its own env var (an IANA name); if
  unset it would fall back to a fixed offset.
- An earlier revision of the bridge hard-coded the US DST rule (nth-Sunday
  arithmetic, ±4/5 h). It was replaced by `zoneinfo` — the same
  fixed-rule → tz-database evolution the fork patch makes on the Node side,
  reached independently, and here with **no third-party dependency**.

---

## 7. Things the bridge does that stock (main) does not

1. Writes pump **IOB** to `/api/v1/devicestatus`.
2. Derives **Meal vs Correction** bolus class from `carbsInput`.
3. DST-correct local→UTC conversion using only the Python standard library.
4. Persists its dedup set across restarts without reading anything back from
   Nightscout.
5. Writes **no raw-record `notes`**, so no Glooko-side identifiers or timestamps
   are echoed into the treatment store.
6. Runs as a wholly separate process (REST only), so Nightscout and Glooko
   ingest can be upgraded, restarted, or fail independently.
7. Idempotent-skips unmapped / empty records by adding their guid to the seen
   set, instead of re-evaluating them every cycle.

## 8. Things stock does that the bridge does not

1. CGM / `sgv` ingestion (`/api/v2/cgm/readings`, v3 graph fallback, mg/dL×100
   decoding, mmol→mg/dL from profile units).
2. Basal and temp-basal treatments.
3. Pod / sensor / reservoir events and pump alarms (fork patch only).
4. Retry/backoff state machine, session refresh, structured poller.
5. Multi-region server table + `CONNECT_GLOOKO_ENV` / `CONNECT_GLOOKO_SERVER`
   (the bridge just takes two host strings).
6. Two-factor-auth detection.
7. `auto` api→web auth fallback.

---

## 9. Configuration surface (env var **names** only)

Bridge: `GLOOKO_EMAIL`, `GLOOKO_PASSWORD`, `GLOOKO_MY_HOST`, `GLOOKO_API_HOST`,
`GLOOKO_LOCAL_TZ`, `NIGHTSCOUT_URL`, `NIGHTSCOUT_SECRET`, `INTERVAL_MIN`,
`LOOKBACK_DAYS`.

Nearest stock equivalents: `CONNECT_GLOOKO_EMAIL`, `CONNECT_GLOOKO_PASSWORD`,
`CONNECT_GLOOKO_SERVER` / `CONNECT_GLOOKO_ENV`,
`CONNECT_GLOOKO_TIMEZONE` / `CONNECT_GLOOKO_TIMEZONE_OFFSET`, and Nightscout's
own `API_SECRET`. The bridge authenticates to Nightscout with the
`api-secret` header set to the hex SHA-1 of the secret, the same transform the
Nightscout client API documents.
