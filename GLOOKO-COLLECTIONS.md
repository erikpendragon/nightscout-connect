# Glooko collections: what the consumer API serves and what this fork does with it

Reference for `lib/sources/glooko/`. Schema only. Nothing here identifies an
account or carries a therapy value.

## Two APIs, one data model

Glooko publishes a **Direct API** for its commercial customers at
developers.glooko.com. Access is contractual ("Individual user API access is not
available"), it lives on the partner gateway `externalapi.glooko.com`, and it
authenticates with a JWT plus an API key. Nobody running this driver can use it.

What everyone running this driver *does* use is the **consumer API** behind
Glooko's own web app: `api.glooko.com` (or `eu.` / `ca.`), email-and-password
login, session cookie. It is undocumented.

The two are the same collections behind different front doors. Every official
path `/api/v2/external/<x>` has a consumer twin at `/api/v2/<x>`, one for one,
with a single rename (`medications` is `insulins`). That makes the official
documentation a usable field dictionary for the consumer records, with the
differences listed below. It was confirmed by probing every path unauthenticated
(a live route answers 421, a missing one 404, the partner paths 401) and then by
capturing each collection through the driver's own login.

Two things have no v2 twin. The automated-mode spans and basal bars exist only
in `/api/v3/graph/data`. The statistics family has no consumer route at all.
Exercises are not at `/api/v2/exercises`, which exists but is empty; step data
lives under the v3 histories type `validic_routines`.

## Envelope and parameters

Every v2 collection answers

    { "<collectionKey>": [ ... ], "lastPage": bool, "lastUpdatedAt": iso, "lastGuid": string }

and requires `lastUpdatedAt`; without it the answer is 422
`param is missing or the value is empty: lastUpdatedAt`. The driver sends
`patient`, `startDate`, `endDate`, `lastGuid` (a fixed random guid; Glooko does
not appear to check it), `lastUpdatedAt` and `limit`. The three original
collections use a five-minute-aligned cursor; everything added by this fork
uses a fourteen-day wide window, because these records are sparse and sync
lag is around forty minutes.

## How consumer records differ from the official dictionary

| Official | Consumer | Where |
|---|---|---|
| `timestamp` | `pumpTimestamp` | every pump collection |
| `utcOffset` | `pumpTimestampUtcOffset` | every pump collection |
| `deviceGuid` | `pumpGuid` | every pump collection |
| camelCase | snake_case | `pumps/alarms` (`pump_timestamp`, `alarm_severity`, `value`), `cgm/readings` (`display_time`, `bg_value`, `soft_deleted`), `pumps/settings` (whole document) |
| not present | `softDeleted`, `updatedBy`, `pumpName`, `insulinReduction`, `bloodGlucoseInputSource` | consumer keeps storage fields |
| `insulinSensitivityFactor`, `carbsRatio`, `targetBloodGlucose` on boluses | not present | the gateway joins these in from settings |

Field *meanings* carry over exactly. Glooko's own definitions worth knowing:
`override` is recommended minus delivered and is null when the suggestion was
accepted; bolus `type` is `manual` or `suggested`; an alarm's machine-readable
code is in `value`; `syncTimestamp` identifies the upload event and is shared by
every record in it; and every "local time" timestamp is the wall clock stamped
as UTC, with the real offset supplied separately. That last one is why
`CONNECT_GLOOKO_TIMEZONE` exists.

## Units

Glucose in consumer pump records is **mg/dL × 100**: `bloodGlucoseInput` on a
bolus, `value` on a pump reading, and every glucose field in the v2 settings
document. Durations are seconds. The v3 endpoints (`devices_and_settings`,
`graph/data`) convert to the account's display units and to hours. The driver
treats any glucose value at or above 1000 as ×100 and scales it down; a small
value carrying mmol units is converted; BG Check treatments are always posted
in mg/dl.

## The collections, and what each becomes

"Verified" means a live record was captured and the mapper was written against
it. "Inferred" means the collection answered 200 but was empty on the reference
account (an Omnipod 5 in Automated Mode with a Dexcom G7 arriving by cloud, no
meter, nothing logged by hand), so the shape is taken from the official
dictionary plus the sibling collections. When an inferred collection delivers
its first record the batch log prints that record's keys; check them against
the mapper before trusting the output.

| Collection | Key | Status | Nightscout record | `enteredBy` |
|---|---|---|---|---|
| `pumps/normal_boluses` | `normalBoluses` | verified | `Meal Bolus` / `Correction Bolus`; newest with IOB → `devicestatus` | — |
| `pumps/scheduled_basals` | `scheduledBasals` | verified | `Temp Basal` at the programmed rate. This is the pump's *program*, not delivery; nearly empty in Automated Mode | — |
| `pumps/suspend_basals` | `suspendBasals` | verified | `Temp Basal` at 0 U/h for `duration`; `glookoRateAtStart` / `glookoRateAtResume` | `glooko-suspend` |
| `pumps/temporary_basals` | `temporaryBasals` | inferred | `Temp Basal`; absolute `rate` preferred, else `percentage` → relative `percent` (≤ 2 read as a fraction, larger as a percentage). Manual Mode only | `glooko-temp-basal` |
| `pumps/extended_boluses` | `extendedBoluses` | inferred | `Combo Bolus`: `enteredinsulin`, `insulin` (immediate), `splitNow` / `splitExt`, `duration` (min), `relative` (U/h). Manual Mode only | `glooko-extended-bolus` |
| `pumps/events` | `events` | verified | `Site Change` / `Sensor Start` / `Insulin Change` from `pod_activating` / `cgm_sensor_change` / `reservoir_change`; other types ignored | — |
| `pumps/alarms` | `alarms` | verified | `Note` (never `Announcement`) with `glookoAlarm {code, severity, device}` | `glooko-alarm` |
| `pumps/readings` | `readings` | inferred | `BG Check`, `glucoseType: Finger` | `glooko-pump-reading` |
| `readings` (meter) | `readings` | inferred | `BG Check` with the meal tag in the note. Carried in the batch as `meterReadings` because the key collides with the CGM one | `glooko-meter-reading` |
| `cgm/readings` | `readings` | verified | `entries` (`sgv`), unless `CONNECT_GLOOKO_SKIP_ENTRIES` | — |
| `cgm/insulin_events` | `insulinEvents` | inferred | `Note` + `glookoCgmInsulin`; `systemTime` used as real UTC when present | `glooko-cgm-insulin` |
| `cgm/carbs_events` | `carbsEvents` | inferred | `Note` + `glookoCgmCarbs` | `glooko-cgm-carbs` |
| `foods` | `foods` | verified | `Note` | `glooko-food` |
| `blood_pressures` | `bloodPressures` | inferred | `Note` + `glookoBloodPressure {systolic, diastolic, units, pulse?}` | `glooko-blood-pressure` |
| `pumps/settings` | `settings` | verified, **not fetched** | raw snake_case settings document; the driver reads the same data from v3 instead | — |
| `/api/v3/devices_and_settings` | — | verified | Nightscout `profile`, or a `Note` proposing one, per `CONNECT_GLOOKO_PROFILE_SYNC` | `glooko-settings` |
| `/api/v3/graph/data` | — | verified | `entries` fallback when v2 CGM readings are empty | — |
| `insulins` | `insulins` | verified (empty) | not fetched: pen insulin; a pump account has none | — |

Every treatment carries `glookoGuid`, the record's own guid. The Nightscout
output seeds a set of those from the last 45 days on startup and adds to it as
it posts, and the driver drops anything already in the set. That is the
deduplication; timestamps play no part in it.

## The no-double-counting rule

Anything the pump already accounts for is imported as a `Note`, never as a
second treatment that Nightscout would sum. A bolus carries its `carbsInput`,
so food, CGM-app carb events and CGM-app insulin events all become Notes. A
`Carb Correction` or `Correction Bolus` for the same event would count twice
into COB or IOB. The amounts are kept in the note text and in `glooko*`
fields for anything that wants to read them back.

## What a suspend record does and does not tell you

On an Omnipod 5, `pumps/suspend_basals` holds only `type: "manual"` records:
pod changes and deliberate suspends, a handful a year. The algorithm's own
suspensions, which are what explain most overnight basal gaps, are not in any
v2 collection. They appear only as the `basalBarAutomatedSuspend` series of
`/api/v3/graph/data`, which this driver requests only as a CGM fallback.

## Verifying a new collection

1. Turn the feature on and watch the first poll for
   `GLOOKO new <collection>: <n> first record keys: [...]`.
2. Compare the keys against the mapper in `convert.js`. The mappers accept
   both camelCase and snake_case for the fields they need, and skip a record
   that lacks a timestamp or a usable value rather than posting a bad one.
3. If the shape differs, fix the mapper and add the real shape to
   `test/glooko.test.js`; the existing tests carry the inferred shapes and
   should be updated, not duplicated.
