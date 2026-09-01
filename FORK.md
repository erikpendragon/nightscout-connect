# What this fork is

`nightscout-connect` with the Glooko source fixed up for a **Omnipod 5 + Dexcom
G7** deployment, plus several upstream pull requests merged so they can be run
together before they land.

Upstream is `nightscout/nightscout-connect`. Nothing here changes Nightscout
itself.

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
settings need attention, and `NIGHTSCOUT-INSTALL-DELTA.md` for everything in a
working deployment that is not stock.

Configuration *values* — thresholds, targets, timezone, unit choices — are
deliberately not published anywhere in this repo. They are specific to one
person's care and are not reusable. Use your own.

## If you already run your own Glooko bridge

This replaces the Glooko half of it rather than complementing it. Running both
against the same Nightscout will double-post treatments unless one of them is
turned off. `GLOOKO-STANDALONE-BRIDGE.md` describes an independent bridge that
reaches several of the same conclusions by a different route, and where the two
designs agree and differ.
