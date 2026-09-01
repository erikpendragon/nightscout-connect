# Glooko device settings — an endpoint this driver is not using

Findings from a read-only session against the Canadian region, 2026-09-01.
No values appear in this document; everything below is structure.

## Summary

The Glooko source requests `/api/v2/external/pumps/settings`. That path returns
**401 for patient sessions** — confirmed from a fully authenticated browser
session on the patient's own account, so it is not a credential problem in the
driver and no amount of retrying will fix it. The `external/` tree appears to be
for partner integrations, not patients.

The Glooko web app reads the same data from **`/api/v3/devices_and_settings`**,
which returns **200** for that same session.

## Response shape

```
{
  devices: [ {
    id, guid, serialNumber, referenceDeviceId,
    brand, model, type, deviceClassification,
    displayName, shortDisplayName,
    lastSyncTimestamp, lastSyncTimestampUtc,
    deviceOffset, deviceOffsetPresent, recalledTimestamp,
    properties: { cgmModel, deviceVersion }
  } ],
  deviceSettings: {
    pumps:  { <deviceGuid>: { <ISO8601>: <snapshot> } },
    meters: { ... }
  },
  activePumpGuid
}
```

`type` observed as `pump` and `cgm`; both devices appear in `devices`, but only
pumps carried settings.

### A settings snapshot

```
{
  id, deviceGuid,
  syncTimestamp, settingsTimestamp, settingsTimestampUtc, displayableTimestamp,

  generalSettings: { activeInsulinTime, activeCgm },
  bolusSettings:   { bolusCalculatorMinBg, bolusExtendedEnabled,
                     bolusReverseCorrectionEnabled, maxBolus },
  basalSettings:   { maxBasalRate, tempBasalEnabled, activeBasalProgram },

  cgmSettings: { },               // empty in every snapshot observed
  hybridClosedLoopSettings: { },  // empty in every snapshot observed

  profilesBolus: [ { isfSegments, targetBgSegments,
                     insulinToCarbRatioSegments,
                     bgCorrectionThresholdSegments } ],
  pumpProfilesBasal: [ { segments } ]
}
```

`settingsTimestamp` and `settingsTimestampUtc` were both `null` on the account
observed; `syncTimestamp` carried the useful value and matched the snapshot key.
Do not rely on the former two.

### Segment blocks

All five segment objects share one shape:

```
{
  profileName,
  current,            // boolean - the active profile
  dailyTotal,         // number on basal, null on the bolus profiles
  data: [ { segmentStart, duration, value } ],
  graphData, additionalGraphData   // for the web UI; ignore
}
```

- `segmentStart` and `duration` are hours. A single entry with
  `segmentStart: 0, duration: 24` means one flat value all day.
- `targetBgSegments` entries carry `valueLow` and `valueHigh` as well as
  `value`. On the account observed the range fields were zero and only `value`
  was meaningful — check both before trusting either.
- Values arrive in the account's display units. Do not assume mg/dL.

## There is a settings history

Snapshots are keyed by ISO timestamp under each device GUID. The account
observed held four, spread over five months. That is a clinician change log.

Two consequences. A driver can pick the newest snapshot rather than guessing
whether a value is current — and it can notice when a *new* snapshot appears,
which is the moment therapy settings changed. Nothing in Nightscout surfaces
that today.

## What is not here

`cgmSettings` was **empty in every snapshot**. CGM alert thresholds — high, low,
urgent low, rise and fall rates, signal loss, no-readings — are rendered by the
web app from some other source. If you want those in Nightscout they still have
to be set by hand.

## Endpoint status, patient session

| path | status | notes |
|---|---|---|
| `/api/v3/devices_and_settings` | 200 | everything above |
| `/api/v2/external/pumps/settings` | **401** | what the driver currently asks for |
| `/api/v2/device_settings/devices` | 400 | needs parameters, not investigated |
| `/api/v2/device_category_tree` | 200 | reference list of supported devices |
| `/api/v3/devices/time_offsets` | 200 | empty array on this account |
| `/api/v3/cloud_connections` | 200 | linked cloud sources and their state |
| `/api/v3/medical_data/latest_settings` | 200 | wraps `latest_device_settings` |
| `/api/v3/end_dates` | 200 | `endDateDashboard`, `endDateReport` |
| `/api/v2/reference/devices` | 200 | device reference data |

## What this could enable

- Populate the Nightscout profile from the pump — `dia` from
  `activeInsulinTime`, `carbratio`, `sens`, `basal` and target from the segment
  blocks — instead of transcribing them from screenshots by hand.
- Post a note or profile switch when a new snapshot appears, so a settings
  change is visible rather than silent.
- Remove the standing question of whether a hand-copied value is still current.

## Reproducing

Logged into the Glooko web app, on the devices page, in the browser console:

```js
const u = performance.getEntriesByType('resource').map(r => r.name)
  .find(n => n.includes('/api/v3/devices_and_settings'));
const j = await (await fetch(u, { credentials: 'include' })).json();
const g = Object.keys(j.deviceSettings.pumps)[0];
console.log(Object.keys(j.deviceSettings.pumps[g]).sort());   // snapshot timestamps
```

Region hosts follow `<region>.api.glooko.com`; the page's own request carries
whatever query parameters the endpoint needs, so reuse it rather than
constructing one.
