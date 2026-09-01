# Dexcom Clarity — a second API, and the region trap

Findings from a read-only session, 2026-09-01. No values here; structure only.

## It is not the Share API

This driver's `dexcomshare` source talks to the **Share** API: a near-real-time
feed of recent readings, authenticated with account credentials. **Clarity** is a
separate system — OAuth bearer auth, retrospective reporting, different hosts,
different data. Anything below would be a *new source*, not an enhancement to
the existing one.

## The region trap — read this before debugging a login

Dexcom runs **separate account namespaces** for US and international. The same
person, the same device, and the account exists on exactly one of them.

| | US | international |
|---|---|---|
| Clarity | `clarity.dexcom.com` | `clarity.dexcom.eu` |
| identity | `uam1.dexcom.com` | `uam2.dexcom.eu` |
| signup/auth | `signup.dexcom.com` | `signup.dexcom.eu` |
| Share region | `us` | `ous` |

Logging an `ous` account into the US Clarity fails with **"User ID or password
not recognized. Request one-time code to continue."** That message names neither
the region nor the real cause, and it will send someone off resetting a password
that was never wrong. If `CONNECT_SHARE_REGION` is `ous`, the account lives on
`.eu` and nowhere else.

The international OAuth scope also requests `DataShare`, which the US one does
not — a useful tell that you are on the right stack.

## Auth

Bearer token held in the SPA, not a cookie. Replaying a captured URL with
`credentials: 'include'` returns **401**. Any implementation needs the OAuth
flow, not cookie reuse.

## Request pattern

Reports hang off an **analysis session**, which is created by POST:

```
POST /api/subject/<subjectId>/analysis_session          -> sessionId
POST /api/subject/<subjectId>/analysis_session/<sid>/statistics
POST /api/subject/<subjectId>/analysis_session/<sid>/patterns
POST /api/subject/<subjectId>/analysis_session/<sid>/data
POST /api/subject/<subjectId>/analysis_session/<sid>/modal_day
POST /api/subject/<subjectId>/analysis_session/<sid>/pattern_times
GET  /api/subject/<subjectId>/analysis_session/<sid>/target_ranges
GET  /api/subject/<subjectId>/analysis_session/<sid>/post_meal_target_data?date_interval=<from>/<to>
GET  /api/v1/subject/<subjectId>
GET  /api/v1/users/<subjectId>/analysis_session/<sid>/fasting-glucose?startDate=&endDate=
GET  /api/v2/subject/<subjectId>/devices?date_interval=<from>/<to>
GET  /api/v2/subject/<subjectId>/pen-data?date_interval=<from>/<to>
GET  /api/v4/subject/<subjectId>/insulin-pen-data?date_interval=<from>/<to>
GET  /api/v1/home-users/<userGuid>/preferences/color-mode
```

Several report endpoints are POST. GET on them returns 401 or 404, which reads
like an auth failure and is not.

## The one thing worth building

**`/api/v2/subject/<id>/devices` carries the CGM alert settings.** In the UI they
render under *Overview -> Devices*, not under Settings. Fields observed:

```
Low              on/off, threshold, snooze minutes
High             on/off, threshold, delay minutes, snooze minutes
Urgent Low       on/off, threshold, snooze minutes
Urgent Low Soon  on/off, snooze minutes
Falling Fast     on/off, rate per minute
Rising Fast      on/off, rate per minute
Signal Loss      on/off, minutes
```

That is the only Dexcom-side data Nightscout cannot already derive for itself,
and it is what you would need to keep Nightscout's thresholds in step with the
alerts the wearer actually gets. Glooko does **not** carry it — `cgmSettings` in
`/api/v3/devices_and_settings` is empty.

## Two target ranges, both correct

Clarity reports against two different bands and it is not a bug:

- **Overview and Statistics** use the *user's configured* target range.
- **AGP** always uses the international consensus range (3.9-10.0 mmol/L,
  very high above 13.9, very low below 3.0) regardless of user configuration,
  because AGP is a standardised format.

The same fortnight therefore shows two different time-in-range percentages.
Neither is wrong. If you compare a Nightscout figure against a Clarity one,
establish which report it came from first.

Clarity's settings page also states that adjusting target ranges **does not**
affect alert settings, and that range changes made in Clarity propagate to other
Dexcom apps.

## Not worth building

Statistics, AGP percentiles, modal day and pattern detection are all things
Nightscout either computes already or does not need. Sensor and site changes are
better taken from a pump event log where one exists.

## Reproducing

Logged into the correct regional Clarity, on Overview:

```js
performance.getEntriesByType('resource').map(r => r.name)
  .filter(n => /\/api\//.test(n))
  .map(n => new URL(n).pathname.replace(/\/\d{10,}/g, '/<id>'))
  .filter((v, i, a) => a.indexOf(v) === i).sort()
```

The SPA loads everything on first paint and caches it, so patching `fetch`
afterwards captures nothing — arm any interceptor before the initial load, or
read the response bodies from devtools.
