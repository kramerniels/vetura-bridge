# Pi device pairing API (online app)

This document is the contract for the existing online application. The Pi
implements the client side in `src/portal/`. Online app code lives elsewhere.

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
| `unpaired` | Show LAN setup portal (QR / manual setup); poll cloud when configured |
| `paired` | NATS consumer running; LAN portal shows status page |

## User flow

1. Pi boots unpaired → creates identity → starts LAN portal (`pi-api-setup`)
2. If `CLOUD_BASE_URL` is set → registers with the cloud → shows QR + pair URL
3. User opens `{CLOUD_BASE_URL}/devices/pair?deviceId=...&claim=...` (via QR)
4. User logs in on the **online** app and confirms pairing to their tenant
5. Online app enqueues a provisioning job (Scaleway NATS credentials + JetStream consumer)
6. Browser shows a waiting state (“Bezig met aanmaken van certificaten…”) and polls device status until `paired` or `failed`
7. Pi polls bootstrap; when credentials are available it writes creds + `.env`, marks local state `paired`, starts `pi-api` (NATS consumer), and stops cloud polling
8. LAN portal **stays up** and switches to the paired status page (`http://<pi-ip>/` or `http://dkgm-<shortId>.local/`)

Manual fallback (temporary): paste Scaleway `.creds` on the LAN setup page
(`POST /api/manual-setup`).

## Pi on-disk layout

| Path (production) | Purpose |
|-------------------|---------|
| `/var/lib/pi-api/state.json` | Identity: `{ deviceId, claimSecret, state }` |
| `/opt/pi-api/credentials.creds` | NATS credentials after pairing |
| `/opt/pi-api/.env` | Generated NATS config for the consumer |

Local development (macOS / Windows):

| Path | Purpose |
|------|---------|
| `.pi-api-state.json` | Identity state (cwd) |
| `.pi-api-runtime/credentials.creds` | Creds |
| `.pi-api-runtime/.env` | Generated NATS config |

### systemd units

| Unit | Role |
|------|------|
| `pi-api-identity` | Oneshot: ensure identity + hostname `dkgm-<shortId>` |
| `pi-api-setup` | Always-on LAN portal (setup when unpaired, status when paired) |
| `pi-api` | NATS consumer; enabled/started only after pairing |

Required env for QR pairing: `CLOUD_BASE_URL` in `/opt/pi-api/.env`.

## LAN portal (Pi)

Listens on `0.0.0.0:80` (Linux) or `:8080` (local dev).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Setup page (QR) or paired status page |
| `GET` | `/api/status` | `{ state, deviceId, shortId, addresses, cloud, pairUrl }` |
| `POST` | `/api/manual-setup` | JSON body with Scaleway creds + optional NATS fields |

The setup page polls `/api/status` every 3s and reloads when `state` becomes `paired`.

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
  "maxAgeSec": 3600
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

## Publishing commands (after pairing)

Publish to JetStream subject `commands.<deviceId>.<command>`. Current command:
`printLabel`.

```text
commands.<deviceId>.printLabel
```

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

Subscribe to permanent failures for the device on one shared subject:

```text
errors.<deviceId>
```

## Factory reset

On device: `deploy/factory-reset.sh` (as root).

1. Stop `pi-api` and `pi-api-setup`
2. Remove `/opt/pi-api/credentials.creds`
3. Wipe and recreate `/var/lib/pi-api` (new identity on next boot)
4. Disable `pi-api`; re-run `pi-api-identity`; enable/start `pi-api-setup`

Note: `/opt/pi-api/.env` is not wiped (e.g. `CLOUD_BASE_URL` can remain). New
pairing overwrites NATS keys when bootstrap succeeds.

## Security checklist

- Pairing only for authenticated users with tenant device rights
- TLS everywhere for register/bootstrap/pair
- Claim secret: ≥ 32 bytes random; rate-limit register + bootstrap
- Bootstrap payload single-use / short TTL
- Audit who paired which device
- Revoke: delete Scaleway credentials, mark device revoked; on device run
  factory reset
