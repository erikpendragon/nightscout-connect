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

## Addendum 2026-09-02 — mapped without a login

Everything below was established from unauthenticated probes, the identity
server's public discovery document, the pre-login redirect, and the
professional app's bundle. Payload shapes still need a logged-in capture.

### Three systems behind one hostname

1. A Rails shell: landing page, locale, cookie banner, and a CSRF-protected
   login form (`GET /sts_redirect/login` → `POST /users/auth/dexcom_sts`).
   No data routes.
2. Dexcom's identity server, shared with the apps and the signup site:
   `https://uam1.dexcom.com/identity` (US) and `https://uam2.dexcom.com/identity`
   (everyone else; also served from `uam2.dexcom.eu`). OpenID discovery at
   `/identity/.well-known/openid-configuration`.
3. An API gateway under `/api/` that validates the request *before* it checks
   the token: missing route 404 `Route not found`, malformed request 400
   `RequestValidationError`, well-formed request 401 `UnauthorizedError`.

### The login flow, from the redirect

Posting the login form answers 302 to the identity server's
`/identity/connect/authorize` with:

    client_id     = DAEC20AC-9626-4B0E-94B5-B674E298F51E
    response_type = code
    scope         = openid offline_access AccountManagement          (US)
                    openid offline_access AccountManagement DataShare (intl)
    redirect_uri  = https://clarity.dexcom.<com|eu>/users/auth/dexcom_sts/callback
    ui_locales    = en-US

The discovery document lists `authorization_code`, `refresh_token`,
`client_credentials`, `password` and `ExternalIdp` grants and PKCE `S256`.
The `password` grant is listed but was not tried. How the SPA turns the Rails
session into its API bearer token is still unknown; look for it right after
the callback in a capture.

### Contracts

- Subject ids and analysis-session ids are numeric; a GUID in either position
  is 400. Home-user ids are GUIDs.
- `date_interval` is `YYYY-MM-DD/YYYY-MM-DD`. `T`-suffixed values and
  `startDate`/`endDate` pairs are rejected on the v2 routes; the
  fasting-glucose route wants `startDate`/`endDate`.
- Report routes are POST. `POST /api/subject/<id>/analysis_session` with an
  empty body reaches 401, so the session can be created before any report
  parameters; the report sub-routes reject an empty body and a bare
  `{date_interval}` body, so their schema is still unknown.

### Routes beyond the list above

- `GET /api/v2/subject/<id>/alerts?date_interval=…` — exists, not seen in
  the UI session. By name and by the official v3 API's `/alerts`, this is
  alert history (`alertName`, `alertState`, device, times).
- `POST /api/v1/receiver-auth` and `POST /api/v4/subject/<id>/receiver-upload`
  — the uploader's authorisation-code exchange and upload target, from the
  professional bundle. Not relevant to a downloader.
- `/internal/api/v1/audits/users/…` — clinic audit log, professional only.

Names borrowed from the official v3 API (`egvs`, `events`, `calibrations`,
`dataRange`, `alert-settings`, `alert-schedules`, `settings`) do not exist on
Clarity.

### The official v3 API as a field key

Dexcom's developer API (developer.dexcom.com, OAuth, delayed data, not used
here) publishes an OpenAPI spec whose schemas match Clarity's data by content:

- `devices[].alertSchedules[].alertSettings[]` ↔ the alert settings in
  `/api/v2/subject/<id>/devices`: `alertName` ∈ high, low, urgentLow,
  urgentLowSoon, rise, fall, outOfRange, noReadings; `value` (high 120–400 in
  10s, low 60–100 in 5s, rise/fall 2 or 3 mg/dL/min, outOfRange 20–240 min);
  `unit`, `snooze`, `delay`, `secondaryTriggerCondition` (the mg/dL a rate
  alert must also cross), `enabled`, and the time the setting last changed.
  Values are mg/dL regardless of display units.
- `alerts[]` ↔ `/api/v2/subject/<id>/alerts`: `alertName`, `alertState`
  (inactive, activeSnoozed, activeAlarming), `displayDevice`, times.
- `egvs[]` ↔ the analysis-session `data` call: `value` with 39 and 401 as the
  below-40 and above-400 sentinels, `trend` (doubleUp … doubleDown,
  notComputable, rateOutOfRange, with documented mg/dL/min bands),
  `trendRate`, `systemTime`/`displayTime`.

### Capturing

In a browser logged into the correct regional Clarity: DevTools → Network,
Preserve log, filter `/api/`, load Overview then Devices on a fresh page
load, then "Save all as HAR with content". A schema-only summariser that
never copies values lives beside the working notes (`clarity-har-shapes.py`).
