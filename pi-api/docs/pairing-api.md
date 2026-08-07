# Pi device pairing API (online app)

Contract for the online application. The Pi client lives in `src/portal/`.
Online app code lives elsewhere. Pi runtime details (modules, worker manager,
local UI): [README.md](./README.md).

## Concepts

| Term | Meaning |
|------|---------|
| `deviceId` | UUID v4 generated on first boot, stable for the device lifetime |
| `claimSecret` | High-entropy secret generated with the device; proves possession during bootstrap |
| `shortId` | First 8 hex chars of `deviceId` (no dashes); used in mDNS `dkgm-<shortId>.local` |

Credentials created in Scaleway MNQ give **full access** to a NATS account.
Create credentials inside the **tenant/clinic NATS account**, not one global
account shared by all customers.

## Status models

### Cloud (online app)

| Status | Meaning |
|--------|---------|
| `pending` | Registered; waiting for a clinic user to confirm pairing |
| `provisioning` | User confirmed; background job is creating NATS credentials / consumer |
| `paired` | Credentials ready; Pi may fetch bootstrap |
| `failed` | Provisioning job failed (user can retry pair) |

### Pi (local)

Stored in identity state as JSON. Only two values:

| Status | Meaning |
|--------|---------|
| `unpaired` | LAN setup UI (QR / manual); poll cloud when `CLOUD_BASE_URL` is set |
| `paired` | Portal shows status UI; NATS worker runs as a **child of the portal** |

## User flow

1. Pi boots → identity on disk → systemd starts `pi-api` (portal)
2. If unpaired and `CLOUD_BASE_URL` is set → register with cloud → show QR + pair URL
3. User opens `{CLOUD_BASE_URL}/devices/pair?deviceId=...&claim=...` (via QR)
4. User logs in on the **online** app and confirms pairing to their tenant
5. Online app enqueues a provisioning job (Scaleway NATS credentials + JetStream consumer)
6. Browser shows a waiting state (“Bezig met aanmaken van certificaten…”) and polls device status until `paired` or `failed`
7. Pi polls bootstrap; when credentials are available it writes creds + `.env`, marks local state `paired`, **starts the NATS worker child**, and stops cloud polling
8. Portal **stays up** as the paired status page (`http://<pi-ip>/` or `http://dkgm-<shortId>.local/`), including live worker status

Manual fallback (temporary): paste Scaleway `.creds` on the LAN setup page
(`POST /api/manual-setup`) — same apply path, then worker start.

## Pi process model

One long-running systemd unit: **`pi-api`**
([`deploy/pi-api.service`](../deploy/pi-api.service)).

- Starts `src/portal/index.js` and restarts it on failure
- When local state is `paired`, the portal spawns `src/worker/main.js`
  as a child and restarts it with backoff if it exits
- Stopping `pi-api` stops the portal **and** the worker child

There is no separate worker unit.

Required env for QR pairing: `CLOUD_BASE_URL` (in `/opt/pi-api/.env` or the
process environment). Without it, manual setup remains available; no QR.

## Pi on-disk layout

| Path (production) | Purpose |
|-------------------|---------|
| `/var/lib/pi-api/state.json` | Identity: `{ deviceId, claimSecret, state }` |
| `/opt/pi-api/credentials.creds` | NATS credentials after pairing |
| `/opt/pi-api/.env` | NATS config for the worker (+ optional `CLOUD_BASE_URL`) |

Local development (macOS / Windows):

| Path | Purpose |
|------|---------|
| `.pi-api-runtime/state.json` | Identity state |
| `.pi-api-runtime/credentials.creds` | Creds |
| `.pi-api-runtime/.env` | Generated NATS config |

## LAN portal (Pi)

Listens on `0.0.0.0:80` (Linux) or `:8080` (local dev). Entry: `npm start`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Setup page (QR) or paired status page |
| `GET` | `/api/status` | `{ state, deviceId, shortId, addresses, cloud, pairUrl, worker }` |
| `POST` | `/api/manual-setup` | JSON body with Scaleway creds + optional NATS fields |

- Setup page polls `/api/status` every 3s and reloads when `state` becomes `paired`
- Paired page polls `/api/status` every 3s for worker status (`desired`, `running`, `pid`, `restarts`, `lastError`, …)

Full status shape: [README.md](./README.md).

## Endpoints (cloud)

Base URL: `{CLOUD_BASE_URL}` (HTTPS).

### `POST /api/devices/register`

Pi → cloud. Idempotent for the same `deviceId`.

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "claimSecret": "base64url-secret",
  "shortId": "550e8400"
}
```

**Responses**

- `200` / `201` — registered or already pending/provisioning/paired for this claim
- `409` — `deviceId` exists with a different claim (reject)
- `429` — rate limited

Store a **hash** of `claimSecret` (e.g. SHA-256), not the raw secret at rest if
avoidable. Mark device `pending` until pair completes.

The Pi stores the **raw** `claimSecret` locally in `state.json` (mode `0600`).

### `GET /devices/pair?deviceId=...&claim=...`

Browser UI (not called by the Pi). Requires an authenticated clinic user.

- Validate `deviceId` exists and `claim` matches
- If status is `pending`: show confirm button
- If status is `provisioning`: show waiting UI (certificates / NATS setup in progress); poll status
- If status is `paired`: show success (“Apparaat gekoppeld”)
- If status is `failed`: show error + retry button
- On confirm → `POST /api/devices/:id/pair` (session cookie / bearer)

### `POST /api/devices/:id/pair`

Authenticated user confirms linking the device to their tenant.

Creating Scaleway credentials can take several seconds. Treat this as an
**async job**: return immediately and finish provisioning in the background.

**Immediate server actions**

1. Authorize: user may manage devices for this tenant
2. Mark device `provisioning` with `tenantId`, `pairedBy`, `provisioningStartedAt`
3. Enqueue provisioning job
4. Respond (do **not** wait for Scaleway)

**Response (example)**

```json
{
  "ok": true,
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "provisioning"
}
```

Idempotent: if already `provisioning` or `paired` for this tenant, return the
current status without starting a duplicate job (unless retrying from `failed`).

**Background job**

1. Call Scaleway MNQ API to create NATS credentials for the tenant NATS account  
   `POST https://api.scaleway.com/mnq/v1beta1/regions/{region}/nats-credentials`  
   body: `{ "name": "pi-<deviceId>", "nats_account_id": "<tenant-account>" }`
2. Ensure JetStream stream `commands` (subjects `commands.>`) exists
3. Ensure durable consumer:
   - name: `pi-<deviceId>`
   - filter: `commands.<deviceId>.>` (all commands for this device)
4. Store one-time bootstrap payload for the Pi (short TTL, e.g. 15 minutes)
5. On success → mark device `paired` with `pairedAt`
6. On failure → mark device `failed` with `provisioningError` (and optionally alert ops)

### `GET /api/devices/:id` (optional, for frontend only)

Authenticated clinic user. Used by the pair UI to poll while status is
`provisioning`.

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "shortId": "550e8400",
  "status": "provisioning",
  "provisioningError": null
}
```

### `GET /api/devices/:id/bootstrap`

Pi → cloud. Auth: `Authorization: Bearer <claimSecret>`.

Pi polling: register retry every **10s** until success, then bootstrap every **3s**.
`204` / `404` / `409` → not ready (keep polling). `401` / `403` → bad claim.

**Responses**

- `204` / `404` / `409` — not ready yet (Pi keeps polling)
- `401` / `403` — bad claim
- `200` — ready (return **once**; invalidate after successful fetch)

```json
{
  "natsUrl": "tls://nats.mnq.nl-ams.scaleway.com:4222",
  "credsFileContents": "-----BEGIN NATS USER JWT-----\n...\n",
  "maxAgeSec": 900
}
```

Field `credsFileContents` is the full Scaleway `.creds` file body (returned only
once by Scaleway when credentials are created — persist encrypted until the Pi
fetches bootstrap).

Prefer **not** returning NATS subjects or consumer names. The Pi composes them
from `deviceId` (and accepts optional overrides if present):

| Name | Value |
|------|--------|
| stream | `commands` |
| consumer filter / subject | `commands.<deviceId>.>` |
| consumer | `pi-<deviceId>` |
| error subject | `errors.<deviceId>` |
| result subject | `results.<deviceId>` |

## Publishing commands (after pairing)

Publish to JetStream subject `commands.<deviceId>.<command>`. Commands:
`printLabel`, `ping`, `systemUpdate`, `systemReboot`, `setHeartbeatInterval`,
`update`.

```text
commands.<deviceId>.printLabel
commands.<deviceId>.ping
commands.<deviceId>.systemUpdate
commands.<deviceId>.systemReboot
commands.<deviceId>.setHeartbeatInterval
commands.<deviceId>.update
```

### `printLabel`

Payload (command is taken from the subject suffix; body is the command data):

```json
{
  "jobId": "...",
  "organizationId": "...",
  "printerId": "...",
  "zpl": "^XA...^XZ",
  "ip": "172.16.57.115",
  "port": 9100,
  "copies": 1
}
```

### `ping`

Body must be an empty object:

```json
{}
```

On success the worker publishes system diagnostics (version, disk, memory, OS,
network, device identity) inside the result envelope on `results.<deviceId>`.

### `systemUpdate`

Runs a **fixed apt recipe** on the device (no free-form shell/apt flags). Never
reboots; check `rebootRequired` in the result and send `systemReboot` separately
when needed.

```json
{ "recipe": "fullUpgrade" }
```

| `recipe` | Behavior |
|----------|----------|
| `fullUpgrade` | `apt-get update` + `apt-get upgrade -y` (noninteractive, force-confold) |
| `distUpgrade` | `apt-get update` + `apt-get dist-upgrade -y` |

Example success `result`:

```json
{
  "recipe": "fullUpgrade",
  "ok": true,
  "rebootRequired": true,
  "durationMs": 123456,
  "apt": { "updateExitCode": 0, "upgradeExitCode": 0 },
  "summary": "…truncated apt output…"
}
```

Requires root helpers + sudoers on the Pi (see [Maintenance helpers](#maintenance-helpers)).

### `systemReboot`

Body must be an empty object:

```json
{}
```

Schedules a reboot after publishing `{ "ok": true, "scheduled": true }`. The
cloud decides when (for example after `systemUpdate` returns
`rebootRequired: true`).

### `setHeartbeatInterval`

Changes how often the worker publishes a proactive heartbeat (see
[Heartbeat](#heartbeat)). The new interval applies immediately in memory and
resets to the default (3600s) when the worker restarts.

```json
{ "intervalSec": 300 }
```

| Field | Rules |
|-------|--------|
| `intervalSec` | integer, minimum `60`, maximum `86400` |

Example success `result`:

```json
{ "intervalSec": 300 }
```

### `update`

Replaces the application tree at `/opt/pi-api` from an HTTPS zip download (no
git on the device). Preserves `.env` and `credentials.creds`. On success schedules
`systemctl restart pi-api` so portal + worker load the new code; helpers/sudoers/
unit are re-synced on the next start (see [Maintenance helpers](#maintenance-helpers)).

```json
{ "url": "https://example.com/releases/pi-api-2.1.0.zip" }
```

| Field | Rules |
|-------|--------|
| `url` | HTTPS URL to a zip of the app package (must include `node_modules`) |

Example success `result`:

```json
{
  "ok": true,
  "version": "2.1.0",
  "restartScheduled": true,
  "durationMs": 12345
}
```

**Cloud concurrency:** while an `update` is in flight for a device, the cloud
must **not** publish other commands to that device (`printLabel`, `ping`,
`systemUpdate`, `systemReboot`, `setHeartbeatInterval`, another `update`, …).
The worker does not enforce an exclusive lock in v1. Resume other commands after
the matching `results` / `errors` message (or a cloud-side timeout).

**Rollback:** if the swap fails after moving the live tree aside, the helper
restores `/opt/pi-api.previous` → `/opt/pi-api`. After a successful swap the
previous tree is deleted to free disk.

#### Packaging the release zip

Build on **linux/arm64** (Pi architecture) when possible so native deps match.

Include at least:

| Path | Required |
|------|----------|
| `package.json` | yes (`"name": "pi-api"`) |
| `package-lock.json` | recommended |
| `src/` | yes |
| `deploy/` | yes (helpers, `sync-helpers.sh`, `pi-api.service`, `sudoers-pi-api`) |
| `node_modules/` | yes — install with `npm ci --omit=dev` before zipping |

Do **not** include `.env`, `credentials.creds`, or `.git`.

Example:

```bash
npm ci --omit=dev
zip -r "pi-api-${VERSION}.zip" package.json package-lock.json src deploy node_modules
# Upload the artifact; cloud sends the HTTPS URL via commands.<deviceId>.update
```

Zip layout may be flat (files at zip root) or a single top-level folder that
contains `package.json`.

### Success and failure subjects

Subscribe to permanent failures for the device on one shared subject:

```text
errors.<deviceId>
```

Subscribe to successful command results (JSON) on:

```text
results.<deviceId>
```

Result envelope:

```json
{
  "command": "ping",
  "messageId": "42",
  "result": {},
  "timestamp": "2026-08-07T16:00:00.000Z"
}
```

`result` is the script stdout JSON (`printLabel`: printer ack; `ping`: system
info; `systemUpdate` / `systemReboot` / `update`: maintenance summary;
`setHeartbeatInterval`: new interval). All successful commands publish here.
Proactive heartbeats also use this subject (see [Heartbeat](#heartbeat)).

## Heartbeat

After connecting to NATS, the worker publishes a lightweight heartbeat on
`results.<deviceId>` immediately, then on a timer (default every **3600**
seconds). The interval can be changed at runtime with `setHeartbeatInterval`;
it is **not** persisted across worker restarts.

Envelope (same shape as command results; `messageId` is `null` because there
is no JetStream stream sequence):

```json
{
  "command": "heartbeat",
  "messageId": null,
  "result": {
    "deviceId": "550e8400-e29b-41d4-a716-446655440000",
    "intervalSec": 3600,
    "timestamp": "2026-08-07T17:00:00.000Z"
  },
  "timestamp": "2026-08-07T17:00:00.000Z"
}
```

## Maintenance helpers

The worker runs as `pi-api` and calls fixed root helpers via sudo (`sudo -n`):

| Helper | Command |
|--------|---------|
| `/usr/local/sbin/pi-api-system-update` | `systemUpdate` |
| `/usr/local/sbin/pi-api-system-reboot` | `systemReboot` |
| `/usr/local/sbin/pi-api-app-update` | `update` |

Helpers, sudoers, and the systemd unit are **synced automatically** on every
portal start by:

```ini
ExecStartPre=+/opt/pi-api/deploy/sync-helpers.sh
```

(`+` = run as root). That script installs:

1. `deploy/helpers/*` → `/usr/local/sbin/` (mode `0755`, `root:root`)
2. `deploy/sudoers-pi-api` → `/etc/sudoers.d/pi-api` (validated with `visudo -cf`, mode `0440`)
3. `deploy/pi-api.service` → `/etc/systemd/system/pi-api.service` + `systemctl daemon-reload`

So the first boot after placing the package under `/opt/pi-api`, and every
restart after an OTA `update`, picks up new helpers without a manual copy step.

Bootstrap for a brand-new image still needs the package at `/opt/pi-api` and the
unit enabled once (or the unit already pointing at `ExecStartPre` / `ExecStart`
under `/opt/pi-api`); after that, sync keeps the rest current.

The unit must **not** set `NoNewPrivileges=yes` or `ProtectSystem=strict` (those
block sudo/`apt`). `AmbientCapabilities=CAP_NET_BIND_SERVICE` remains for port
80. Sudoers allows only:

```text
pi-api ALL=(root) NOPASSWD: /usr/local/sbin/pi-api-system-update, /usr/local/sbin/pi-api-system-reboot, /usr/local/sbin/pi-api-app-update
```

## Factory reset

No dedicated reset script in the repo yet. On the device (as root), roughly:

1. `systemctl stop pi-api` (stops portal + worker child)
2. Remove `/opt/pi-api/credentials.creds`
3. Wipe and recreate `/var/lib/pi-api` (new identity on next portal start)
4. `systemctl start pi-api`

Note: `/opt/pi-api/.env` need not be wiped (e.g. `CLOUD_BASE_URL` can remain).
New pairing overwrites NATS keys when bootstrap succeeds.

## Security checklist

- Pairing only for authenticated users with tenant device rights
- TLS everywhere for register/bootstrap/pair
- Claim secret: ≥ 32 bytes random; rate-limit register + bootstrap
- Bootstrap payload single-use / short TTL
- Audit who paired which device
- Revoke: delete Scaleway credentials, mark device revoked; on device run
  factory reset
