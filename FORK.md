# What this fork is

`nightscout-connect` with the Glooko source fixed up for a **Omnipod 5 + Dexcom
G7** deployment, plus several upstream pull requests merged so they can be run
together before they land.

Upstream is `nightscout/nightscout-connect`. Nothing here changes Nightscout
itself.

It exists mainly to serve
[nightscout-tdisplay](https://github.com/erikpendragon/nightscout-tdisplay),
whose wear-time page needs the pump events that stock nightscout-connect never
fetches — but the fixes stand on their own and are useful without the display.

## Which branch

**`main`** — use this. It is upstream plus everything below, and it is what runs
in production on the deployment this was developed against.

Feature branches (`log-scrub`, `glooko-collections`) exist only to carry pull
requests upstream. They are deliberate *subsets* of `main` — cut from
`upstream/main` and missing things `main` has — so do not deploy from them.

## What it adds over upstream

**Pump events, alarms and wear time.** Glooko has always carried the pump's own
event log, but the driver never requested it. `cage`, `sage` and `iage` now
populate from the pump's record instead of needing site and sensor changes
logged by hand in careportal.

    pod_activating     -> Site Change      (CAGE)
    cgm_sensor_change  -> Sensor Start     (SAGE)
    reservoir_change   -> Insulin Change   (IAGE)

Pump and CGM alarms are imported as `Note` (never `Announcement`, which would
raise notifications).

**Deduplication on Glooko's `guid` rather than a timestamp.** Sync lag is around
40 minutes, so an event can arrive after a bolus that happened later than it did
and fall behind a time cursor permanently. Boluses carry their guid too —
without it the wide fetch re-offers every bolus every cycle, and once the event
type is derived from `carbsInput` the same carb-free bolus lands twice under
different names and insulin-on-board counts it twice.

**Carb-free boluses are `Correction Bolus`, not `Meal Bolus`.** Labelling every
pump bolus a meal makes the two indistinguishable and inflates anything counting
meals.

**DST-correct timestamps.** `CONNECT_GLOOKO_TIMEZONE` takes an IANA zone and
converts per timestamp. The stock `CONNECT_GLOOKO_TIMEZONE_OFFSET` is a fixed
hour offset — right for half the year, silently an hour wrong for the other
half. The offset remains as a fallback.

**devicestatus deduplication.** The IOB record is derived from the newest bolus
in the window, so the same one is produced every poll and Nightscout does not
deduplicate it. Four copies of one reading accumulated within an hour before
this.

**Credential scrubbing in logs.** xstate's bare `actions.log()` logs
`{ context, event }` in 31 places, and the source drivers carry session cookies
and account profiles in `event.data`. A live session cookie was recoverable from
`docker logs` and still worked for authenticated API calls.

**`CONNECT_GLOOKO_SKIP_ENTRIES`.** Running the Glooko source beside a direct CGM
source has both writing the same readings a second apart. Set it to `true` on an
instance whose CGM arrives elsewhere; treatments and device status still flow.

**Food import**, as `Note` rather than carb treatments — the bolus already
carries `carbsInput` and a second carb entry would double-count into COB.

**Every collection Glooko's consumer API exposes.** Stock nightscout-connect
requests three: scheduled basals, normal boluses and CGM readings. `main`
requests eighteen per poll. What each becomes in Nightscout:

| Glooko collection | Nightscout record |
|---|---|
| `pumps/normal_boluses` | `Meal Bolus` / `Correction Bolus`, plus `devicestatus` IOB |
| `pumps/scheduled_basals` | `Temp Basal` at the programmed rate |
| `pumps/suspend_basals` | `Temp Basal` at 0 U/h for the suspension |
| `pumps/temporary_basals` | `Temp Basal`, absolute rate or relative percent |
| `pumps/extended_boluses` | `Combo Bolus` with split, duration and rate |
| `pumps/events` | `Site Change` / `Sensor Start` / `Insulin Change` |
| `pumps/alarms` | `Note` |
| `pumps/readings`, `readings` (meter) | `BG Check` |
| `cgm/readings` | `entries`, unless `CONNECT_GLOOKO_SKIP_ENTRIES` |
| `cgm/insulin_events`, `cgm/carbs_events`, `foods` | `Note` |
| `blood_pressures` | `Note` with the values in `glookoBloodPressure` |
| `/api/v3/devices_and_settings` | Nightscout `profile`, or a `Note` proposing one |
| `/api/v3/users/summary/histories` (`validic_routines`) | `Exercise` per day with the step total |

Every record carries `glookoGuid` and an `enteredBy` naming its source, and is
dated at the pump's own timestamp. On an Omnipod 5 in Automated Mode several of
these collections are empty by nature — temp basals, extended boluses and manual
suspends are Manual Mode features — so their mappers were written against
Glooko's official Direct API dictionaries rather than live records, and the
batch log prints the first record's keys when one arrives. `GLOOKO-COLLECTIONS.md`
has the full account: how the official documentation maps onto the consumer
API, the envelope and parameters, units, and the status of each mapper.

**Pump therapy settings → Nightscout profile.** Glooko carries the pump's own
insulin duration, carb ratio, correction factor, targets and basal schedule.
`CONNECT_GLOOKO_PROFILE_SYNC=propose` posts a `Note` saying what the pump
holds; `override` writes them into the Nightscout profile; `off`, the default,
does not even request them. When a pump answers but its settings are in a shape
the converter does not recognise, it says so and lists the field names it saw -
names only, no values - so the note doubles as the bug report needed to add that
pump. Read from `/api/v3/devices_and_settings`; see the README and
`GLOOKO-DEVICE-SETTINGS.md`.
The stock driver's `PumpSettings` constant pointed at Glooko's *partner*
gateway path, which answers 401 to a consumer login; it now names the consumer
twin, though the v3 endpoint remains the one actually read.

## Upstream PRs merged here

| | |
|---|---|
| #55 | dexcomshare: surface auth failures, G7 response shape |
| #56 | per-collection cursors, log redaction |
| #58 | DST-aware Glooko timestamps |
| #60 | stop sending v2 sync params to v3 endpoints |

Merged locally so they can be run together. Credit to their authors; if they
land upstream these merges become no-ops.

## Open pull requests from this fork

| | |
|---|---|
| #61 | credential scrubbing in console output |
| #63 | pump events, alarms, scheduled basals, guid dedup (closes #45) |

## Deploying it

See `GLOOKO-PUMP-EVENTS.md` for what the patch does and which Nightscout
settings need attention, and `GLOOKO-COLLECTIONS.md` for every collection the
driver requests and what it becomes.

Configuration *values* — thresholds, targets, timezone, unit choices — are
deliberately not published anywhere in this repo. They are specific to one
person's care and are not reusable. Use your own.

## If you already run your own Glooko bridge

This replaces the Glooko half of it rather than complementing it. Running both
against the same Nightscout will double-post treatments unless one of them is
turned off.

## Migrating from your own Glooko bridge

Nothing here rewrites history. The Glooko source fetches a **two day** window
per cycle (`two_days_ago`, `lib/sources/glooko/index.js`) — it is a live feed,
not a backfill tool. Everything already in your database stays as it is.

On startup the Nightscout output **seeds its dedup set from what you already
have**: up to 500 treatments from the last 45 days, collecting their
`glookoGuid`. Because the seed window is far wider than the fetch window,
anything it could re-pull is already known to it — *provided your bridge writes
that same field*. That is the one thing to check before you start.

### 1. Back up

```bash
mongodump --uri "$MONGO_URI" --out ~/ns-backup-$(date +%F)
```

### 2. Confirm the guid field name — blocking

```bash
curl -s "$NS/api/v1/treatments.json?count=5" \
  | jq '.[] | {created_at, eventType, glookoGuid}'
```

If `glookoGuid` is present, continue. If it is `null` or absent, **stop** — your
bridge stores the guid under a different key, the seed will match nothing, and
the fork will re-import the last two days as duplicates. Either rename the field
on existing records first, or accept and clean up two days of overlap knowingly.

### 3. Stop your bridge — disable, do not uninstall

It is your rollback. Confirm it has actually stopped, by watching for new
treatments to cease, before going on. Running both against one Nightscout
double-posts every treatment.

### 4. Deploy this fork on branch `main`

Config keys: `CONNECT_SOURCE=glooko`, `CONNECT_GLOOKO_EMAIL`,
`CONNECT_GLOOKO_PASSWORD`, `CONNECT_GLOOKO_ENV` (region),
`CONNECT_GLOOKO_TIMEZONE`, `CONNECT_GLOOKO_TIMEZONE_OFFSET`,
`CONNECT_NIGHTSCOUT_ENDPOINT`, `API_SECRET`.

**Leave `CONNECT_GLOOKO_SKIP_ENTRIES` set** if your CGM already arrives by
another route — a Dexcom Share connector, say. Glooko carries the same Dexcom
readings, and importing both produces a duplicate glucose row every five
minutes. This is not theoretical; it has been done, and it took a purge to undo.

### 5. Watch the first cycle

```
SEEDED <n> known source guids
RECORD BATCH with <e> entries, <t> treatments, <d> devicestatus, <p> profiles
```

If `n` is 0, or the SEEDED line never appears at all, stop and go back to step 2.

### 6. Verify

- Treatment count should rise by roughly what two days actually contains, not by
  a doubling.
- `devicestatus` device name changes from your bridge's to `glooko (<pump>)`.
- `Site Change`, `Sensor Start` and `Insulin Change` treatments begin appearing.
  These are new — your bridge did not import them. They need `cage sage iage` in
  `SHOW_PLUGINS` before the wear-time pills will render.
- Where the account has the data, so do zero-rate `Temp Basal` (suspends),
  `BG Check` (meter or pump readings), `Combo Bolus` (extended boluses),
  `Exercise` (one per day carrying the step total from a phone or watch) and
  `Note` records from the CGM app and blood-pressure log. `enteredBy` says which
  collection each came from.

### Rollback

Stop this, re-enable your bridge. Records written here carry `glookoGuid`, so a
guid-deduping bridge will not duplicate them on the way back either.

## Tracking upstream

Currently based on upstream `b394411` (*Merge pull request #26 from
nightscout/dev*, 2026-07-07), with **0** upstream commits not yet incorporated.

Upstream moves in infrequent bursts rather than continuously, so this is
maintained by hand when it does. The procedure:

```bash
git remote add upstream https://github.com/nightscout/nightscout-connect.git
git fetch upstream
git checkout main
git merge upstream/main          # merge, do NOT rebase - see below
npm test                          # must stay green
# deploy, confirm the feed is still flowing, then:
git push origin main
```

`main` is the only long-lived branch here. An earlier `integration` branch
staged upstream merges before fast-forwarding `main`; it never once diverged
from `main`, so it bought nothing and gave people a second name to deploy by
mistake. If you want a scratch branch to resolve a messy merge on, cut one
locally and delete it afterwards — it does not need to be published.

**Merge rather than rebase.** Four upstream pull requests (#55, #56, #58, #60)
are merged into this branch locally so they can run together before they land.
If any of them is merged upstream, a `merge` recognises the shared history and
the local merge quietly becomes redundant. A `rebase` would replay those changes
on top of an upstream that already contains them, and the conflicts are
unpleasant.

`lib/sources/glooko/index.js` and `lib/sources/glooko/convert.js` carry the bulk
of the changes and are where conflicts will land if upstream touches the Glooko
driver.

**Verify it runs, not just that it builds.** A green test suite is necessary and
not sufficient here — an optional `require` behind a `try/catch` can leave a
feature completely inert while every test still passes. After an upstream merge,
confirm that treatments are actually arriving and that `cage`/`sage`/`iage`
still populate, not merely that the process starts.
