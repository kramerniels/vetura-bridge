# NATS commands (after pairing)

Protocol for publishing work to a paired Pi and consuming results. Pairing /
bootstrap: [pairing-api.md](./pairing-api.md). Pi runtime and systemd:
[README.md](./README.md).

## Subjects

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

## Commands

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

Replaces the application tree at `/opt/dkgm-agent` from an HTTPS zip download (no
git on the device). Preserves `.env` and `credentials.creds`. On success schedules
`systemctl restart dkgm-agent` so portal + worker load the new code; helpers/sudoers/
unit are re-synced on the next start (see [Maintenance helpers](#maintenance-helpers)).

```json
{ "url": "https://example.com/releases/dkgm-agent-2.1.0.zip" }
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
restores `/opt/dkgm-agent.previous` → `/opt/dkgm-agent`. After a successful swap the
previous tree is deleted to free disk.

#### Packaging the release zip

Build on **linux/arm64** (Pi architecture) when possible so native deps match.

Include at least:

| Path | Required |
|------|----------|
| `package.json` | yes (`"name": "dkgm-agent"`) |
| `package-lock.json` | recommended |
| `src/` | yes |
| `packaging/` | yes (helpers, `sync-helpers.sh`, `dkgm-agent.service`, `sudoers-dkgm-agent`) |
| `node_modules/` | yes — install with `npm ci --omit=dev` before zipping |

Do **not** include `.env`, `credentials.creds`, `.git`, or `tools/` (dev-only).

Example:

```bash
npm ci --omit=dev
zip -r "dkgm-agent-${VERSION}.zip" package.json package-lock.json src packaging node_modules
# Upload the artifact; cloud sends the HTTPS URL via commands.<deviceId>.update
```

Fresh devices get the same product paths via the golden SD image
([tools/image/README.md](./tools/image/README.md)); never include `tools/` in
the zip.

Zip layout may be flat (files at zip root) or a single top-level folder that
contains `package.json`.

## Success and failure subjects

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

The worker runs as `dkgm-agent` and calls fixed root helpers via sudo (`sudo -n`):

| Helper | Command |
|--------|---------|
| `/usr/local/sbin/dkgm-agent-system-update` | `systemUpdate` |
| `/usr/local/sbin/dkgm-agent-system-reboot` | `systemReboot` |
| `/usr/local/sbin/dkgm-agent-app-update` | `update` |

Helpers, sudoers, and the systemd unit are **synced automatically** on every
portal start by:

```ini
ExecStartPre=+/opt/dkgm-agent/packaging/sync-helpers.sh
```

(`+` = run as root). That script installs:

1. `packaging/helpers/*` → `/usr/local/sbin/` (mode `0755`, `root:root`)
2. `packaging/sudoers-dkgm-agent` → `/etc/sudoers.d/dkgm-agent` (validated with `visudo -cf`, mode `0440`)
3. `packaging/dkgm-agent.service` → `/etc/systemd/system/dkgm-agent.service` + `systemctl daemon-reload`

So the first boot after the golden image (or every restart after an OTA
`update`) picks up new helpers without a manual copy step. The image build
places the package at `/opt/dkgm-agent` and enables the unit
([tools/image/README.md](./tools/image/README.md)); after that, sync keeps the
rest current. Unit context:
[README.md — systemd](./README.md#systemd-production-on-the-pi).

The unit must **not** set `NoNewPrivileges=yes` or `ProtectSystem=strict` (those
block sudo/`apt`). `AmbientCapabilities=CAP_NET_BIND_SERVICE` remains for port
80. Sudoers allows only:

```text
dkgm-agent ALL=(root) NOPASSWD: /usr/local/sbin/dkgm-agent-system-update, /usr/local/sbin/dkgm-agent-system-reboot, /usr/local/sbin/dkgm-agent-app-update
```

## Related

- Cloud pairing contract: [pairing-api.md](./pairing-api.md)
- Pi runtime (portal, systemd): [README.md](./README.md)
