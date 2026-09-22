# vetura-agent

Raspberry Pi app for Vetura: LAN portal (setup / status) plus a NATS JetStream
worker for remote commands. This repository **is** the `vetura-agent` package
(installed to `/opt/vetura-agent` on the device). Local-only helpers live under
`tools/`.

| Doc | Audience |
|-----|----------|
| [tools/image/README.md](./tools/image/README.md) | Install on a Pi: build & flash the golden SD image |
| [pairing-api.md](./pairing-api.md) | Cloud pairing contract (register / pair / bootstrap) |
| [commands.md](./commands.md) | NATS subjects, command payloads, heartbeat, helpers |

Entry point: `src/portal/index.js` (`npm start`).

## Layout

```text
.
├── src/                 # portal + NATS worker
├── packaging/           # systemd unit, helpers (runtime + OTA)
├── tools/
│   ├── image/           # pi-gen golden SD image (first install)
│   └── pairing-mock/    # local cloud pairing API (dev only)
├── pairing-api.md
└── commands.md
```

## Install on a Raspberry Pi

Flash the golden image — that is the only first-install path. See
[tools/image/README.md](./tools/image/README.md) (Pi 5 or Pi 4 Model B, pubkey-only SSH,
first-boot LUKS, per-device signed-boot lock, then QR pairing). App updates after pairing go over NATS
([commands.md](./commands.md)).

## Role

| State | Portal |
|-------|--------|
| `unpaired` | Setup page with QR / pair URL |
| `paired` | Status page (deviceId, mDNS, NATS subjects, worker status) |

When `paired`, the portal starts the NATS worker as a child process and keeps it
running (restart with backoff on crash). systemd only supervises the portal
unit; the worker is not a separate unit.

## Port and reachability

| Environment | Bind | Port |
|-------------|------|------|
| Linux (production) | `0.0.0.0` | `80` |
| macOS / Windows (dev) | `0.0.0.0` | `8081` |

Reachable via Pi IP or mDNS: `http://vetura-<shortId>.local/`  
(`shortId` = first 8 hex chars of `deviceId`).

## Startup

1. `ensureIdentity()` — reads or creates `deviceId` + `claimSecret` + state
2. If `paired` → start worker manager (`ensureStarted`)
3. If `unpaired` → start cloud loop (register + bootstrap poll)
4. Start HTTP server (`createSetupServer`)
5. On SIGINT/SIGTERM → stop cloud loop, stop worker, close server

Required env for QR pairing: `CLOUD_API_URL` and `CLOUD_FRONTEND_URL` (in
`/opt/vetura-agent/.env` or local `.env`). Without the API URL the cloud loop does
not start; without the frontend URL the QR is missing.

## Modules

```text
src/portal/
  index.js           — process: identity, cloud loop, worker manager, HTTP server
  worker-manager.js  — spawn / restart / status of NATS consumer child
  server.js          — routes + static files
  cloud.js           — register + bootstrap polling
  apply.js           — write creds/.env, state → paired
  view-controller.js — Mustache templates + QR
  network.js         — LAN IPv4 addresses
  public/            — setup.html, paired.html, css/, js/
```

## HTTP API

| Method | Path | Purpose |
|--------|-------|---------|
| `GET` | `/` | Setup or paired page (depends on state) |
| `GET` | `/api/status` | JSON: state, deviceId, shortId, addresses, cloud, pairUrl, worker |
| `GET` | `/css/*`, `/js/*` | Static assets |

### `GET /api/status`

```json
{
  "state": "unpaired",
  "deviceId": "…",
  "shortId": "550e8400",
  "addresses": [{ "interface": "eth0", "address": "192.168.1.10" }],
  "cloud": {
    "cloudConfigured": true,
    "registered": true,
    "stopped": false,
    "lastError": null,
    "lastRegisterAt": "…",
    "lastPollAt": "…"
  },
  "pairUrl": "https://…/devices/pair?deviceId=…&claim=…",
  "worker": {
    "desired": false,
    "running": false,
    "pid": null,
    "startedAt": null,
    "restarts": 0,
    "lastExitCode": null,
    "lastExitAt": null,
    "lastError": null
  }
}
```

`cloud` is `null` when the device is already `paired` (no cloud loop).
When `paired`, `worker.desired` is `true` and `worker.running` reflects the
child process.

## Cloud loop (unpaired)

`cloud.js` → `startCloudLoop`:

1. Build `pairUrl` = `{CLOUD_FRONTEND_URL}/devices/pair?deviceId=…&claim=…`
2. `POST {CLOUD_API_URL}/api/devices/register` — retry every **10s** until success
3. Then `GET {CLOUD_API_URL}/api/devices/:id/bootstrap` with `Authorization: Bearer <claimSecret>` — every **3s**
4. When payload is ready → `configFromBootstrap` + `applyPairing`
5. On success → cloud loop stops; worker starts; UI sees `paired` via status poll

Without `CLOUD_API_URL`: loop does not start; `cloudConfigured: false`.
Without `CLOUD_FRONTEND_URL`: no QR / pair URL.

## Applying pairing (`apply.js`)

Used by cloud bootstrap:

1. Validate creds (must contain `-----BEGIN`) and required NATS fields
2. Write `credentials.creds` + `.env` (mode `0600`)
3. Set identity state to `paired`
4. Portal starts the NATS worker (`onPaired`, or again on boot when already paired)

Default NATS names come from `src/device-nats.js`:

| Field | Value |
|-------|--------|
| stream | `commands` |
| subject | `commands.<deviceId>.>` |
| errorSubject | `errors.<deviceId>` |
| resultSubject | `results.<deviceId>` |
| consumer | `pi-<deviceId>` |

### Paths

| | Production (Linux) | Dev (macOS/Windows) |
|--|--------------------|---------------------|
| Identity | `/var/lib/vetura-agent/state.json` | `.vetura-agent-runtime/state.json` |
| Creds | `/opt/vetura-agent/credentials.creds` | `.vetura-agent-runtime/credentials.creds` |
| Env | `/opt/vetura-agent/.env` | `.vetura-agent-runtime/.env` |

## Frontend

- **Setup** (`setup.html` + `js/setup.js`): QR, pair link, waiting text; polls
  `/api/status` every 3s and reloads when `state === "paired"`.
- **Paired** (`paired.html` + `js/paired.js`): confirmation + subjects; polls
  `/api/status` every 3s for live worker status (running / starting / error).

Templates via Mustache; QR via `qrcode` (`toDataURL`).

## systemd (production on the Pi)

systemd is the process manager on Linux: it starts programs at boot and restarts
them if they crash. You describe each program in a **unit file** (`.service`).

For the app itself there is **one** long-running unit: the portal.

| Unit | Role |
|------|------|
| `vetura-agent` | Starts the portal and keeps it running |

The portal itself starts the NATS worker when the device is paired, and restarts
that worker if it exits. systemd does not manage the worker separately — if the
portal stops, the worker stops with it (and comes back when systemd restarts the
portal).

The recipe for that service lives in
[`packaging/vetura-agent.service`](./packaging/vetura-agent.service)
(`ExecStart` points at `src/portal/index.js`).

Before the portal starts, `ExecStartPre=+/opt/vetura-agent/packaging/sync-helpers.sh`
(as root) installs maintenance helpers, sudoers, and refreshes this unit from
the package tree. See [commands.md — Maintenance helpers](./commands.md#maintenance-helpers)
and the `update` command for OTA app updates.

### Local development

No systemd needed: `npm start` (port 8081). When already paired, the portal
starts the worker child itself.

#### Pairing against the local mock

1. Start the mock cloud API:

```bash
cd tools/pairing-mock && npm start
```

2. Point the portal at it (in `.env` or the process environment):

```bash
CLOUD_API_URL=http://<your-lan-ip>:3457
CLOUD_FRONTEND_URL=http://<your-lan-ip>:3457
```

3. From the repo root: `npm start`, open `http://localhost:8081`, complete
   pairing via the QR / pair URL.

Production uses a real online app with the same contract; do not deploy
`tools/pairing-mock`.

## Related

- Device install (SD image): [tools/image/README.md](./tools/image/README.md)
- Cloud pairing contract: [pairing-api.md](./pairing-api.md)
- NATS commands, heartbeat, helpers: [commands.md](./commands.md)
