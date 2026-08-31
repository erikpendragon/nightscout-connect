# Nightscout install delta (structure only)

An audit of one self-hosted Nightscout deployment for everything that is **not
stock**, so the parts worth upstreaming are separable from the parts that are
just this box. Configuration *values*, thresholds, unit choices, plugin
selection, profile and alarm settings are deliberately excluded — they are
neither reusable nor safe to publish.

## Baseline and method

- **Stock baseline:** the pinned `nightscout/cgm-remote-monitor` Docker image
  (v15.0.7, Node ≥ 20) and the upstream `nightscout-connect` repo.
- **How checked (all structural, no records read):** container image digest vs
  registry; `docker diff` on every running container; `package.json` dependency
  list inside the image; full enumeration of MongoDB collections and their
  index specs; the Compose file; listening sockets; service manager and cron.

## Findings

### Nightscout core — unmodified

- Runs the stock image by digest. `docker diff` on the running container is
  **empty** — no patched, added, or hand-edited files in `lib/`, no injected
  plugins, no `npm install` at runtime.
- `nightscout-connect` is present **only because `cgm-remote-monitor`'s own
  `package.json` depends on it** (`"nightscout-connect": "^0.0.12"`). It is not
  an add-on here.
- `nightscout-connect` is configured for a CGM (`sgv`) source only. The stock
  Glooko source is not in use (no `CONNECT_GLOOKO_*` present). All Glooko-derived
  treatments arrive via the separate bridge below.

### Added container — `glooko-bridge`

The only non-stock moving part in the stack.

- Stock `python:3.13-slim` image, unmodified (`docker diff` shows only stdlib
  `.pyc` cache plus the mounted script — no `pip install`).
- One file bind-mounted read-only; one named volume for dedup state.
- Standard library only. Talks to Nightscout over HTTP REST.
- Behaviour and how it compares to `lib/sources/glooko/` is documented in
  `GLOOKO-STANDALONE-BRIDGE.md`.

### MongoDB — stock schema

- Stock `mongo:7.0` image. The Compose `command:` sets a smaller
  `--wiredTigerCacheSizeGB` and `--quiet` — memory tuning for a small LXC, not a
  schema change.
- **Collections and indexes are exactly what Nightscout creates itself.** No
  custom collection, no custom or compound index, no TTL index, no capped
  collection. Enumerated: `entries`, `treatments`, `food`, `profile`,
  `devicestatus`, `settings`, `activity`, `auth_subjects`, `auth_roles` — every
  index on each is a stock Nightscout index.
- Note: the bridge's `glookoGuid` dedup field is **not** backed by a unique
  index. De-duplication is entirely client-side (see the bridge doc).

### Compose file — the main hand-authored artifact

A single `docker-compose.yml` defines three services (`mongo`, `nightscout`,
`glooko-bridge`) on one user-defined bridge network. Non-stock elements:

- the `glooko-bridge` service definition and its `glooko-state` volume;
- the Mongo `command:` tuning flags above;
- `MONGO_CONNECTION` set inline to the internal service address;
- `INSECURE_USE_HTTP` enabled (TLS is terminated upstream — see below);
- the bridge's environment passed through: `GLOOKO_MY_HOST`, `GLOOKO_API_HOST`,
  `NIGHTSCOUT_URL`, `NIGHTSCOUT_SECRET`, `INTERVAL_MIN`, `LOOKBACK_DAYS`
  (`GLOOKO_LOCAL_TZ` is supported by the script but not currently set here).

### Ingress / TLS

No bundled reverse proxy (no nginx / caddy / traefik). HTTPS is terminated by a
**Tailscale** node running inside the same container, in front of Nightscout's
published port. Infra-level; listed for completeness.

### Process management

Plain `docker compose` with `restart: unless-stopped`. No systemd unit wrapping
it, no cron entries.

### Environment variable names

Only names appear below; no values. Names that are simply stock Nightscout or
stock `nightscout-connect` settings are grouped and not individually discussed —
per the "no preferences / settings" rule.

| Non-default **name**, custom to this deployment | Where |
|---|---|
| `GLOOKO_EMAIL`, `GLOOKO_PASSWORD` | `.env`, consumed by the bridge |
| `GLOOKO_MY_HOST`, `GLOOKO_API_HOST`, `GLOOKO_LOCAL_TZ` | Compose → bridge |
| `NIGHTSCOUT_URL`, `NIGHTSCOUT_SECRET` | Compose → bridge |
| `INTERVAL_MIN`, `LOOKBACK_DAYS` | Compose → bridge |

Everything else in `.env` is a stock name — Nightscout core
(`API_SECRET`, `NODE_ENV`, `TZ`, `INSECURE_USE_HTTP`, `ENABLE`,
`AUTH_DEFAULT_ROLES`, `DISPLAY_UNITS`, `TIME_FORMAT`, `HOSTNAME`) or stock
`nightscout-connect` (`CONNECT_SOURCE`, `CONNECT_SHARE_ACCOUNT_NAME`,
`CONNECT_SHARE_PASSWORD`, `CONNECT_SHARE_REGION`). Their *values* are
configuration and out of scope.

## Differs, but omitted (personal data)

- **`.api_secret_reference.txt`** — a plaintext helper file sitting next to the
  Compose file. Contents not reproduced. It holds credential material and should
  not exist in any repo; noted only so its existence is on record.
- **`.env` values** in full — secrets and preferences.
- **Plugin selection, BG thresholds/targets, display units, time format, auth
  roles, pump/CGM model strings, timezone value** — all present, all
  configuration, none included by request.
