# DKGM Pi golden image

Build a flashable Raspberry Pi OS Lite (64-bit) image with **pi-api** preinstalled.
This is the **only** first-install path for devices. App updates after pairing go
over NATS (see [commands.md](../../commands.md)).

## What you get

| Included | Not included (per device) |
|----------|---------------------------|
| Raspberry Pi OS Lite 64-bit (Trixie) | `/var/lib/pi-api/state.json` |
| Node.js 20 | `credentials.creds` / NATS pairing |
| `/opt/pi-api` + systemd `pi-api` enabled | |
| `/opt/pi-api/.env` with `CLOUD_BASE_URL` | |

On first boot the portal generates a `deviceId`, shows the QR pairing UI on
port 80, and is reachable at `http://dkgm-<shortId>.local/` after identity exists.

## Requirements

- Docker (Linux or macOS; privileged containers + `binfmt` for ARM)
- Git
- Enough disk for pi-gen work dirs (tens of GB)
- [config.local](./config.local.example) with `CLOUD_BASE_URL` and `FIRST_USER_PASS`

On Linux you may need `binfmt` / `qemu-user-static` support so the ARM chroot
works. See the [pi-gen README](https://github.com/RPi-Distro/pi-gen).

## Configure

```bash
cd tools/image
cp config.local.example config.local
# Edit config.local: CLOUD_BASE_URL, FIRST_USER_PASS, optional SSH pubkey
```

Shared defaults live in [`config`](./config) (hostname, locale, SSH enabled, etc.).

## Build

```bash
./build.sh
```

This will:

1. Stage the product package (`package.json`, `src/`, `deploy/`) into the pi-gen stage
2. Clone/update [pi-gen](https://github.com/RPi-Distro/pi-gen) (`arm64` branch) under `.pi-gen/`
3. Run `build-docker.sh` (Lite stages + `stage-dkgm`)
4. Copy artifacts to [`deploy/`](./deploy/)

Output is typically something like `deploy/dkgm-pi-*.img.xz`.

Rebuild after app changes the same way; do not use a separate on-device install script.

## Flash

1. Write the `.img` / `.img.xz` to an SD card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/),
   Balena Etcher, or `dd` / `xzcat … | dd …`
2. Boot the Pi (Ethernet recommended for first setup; Wi‑Fi country is set to `NL` in `config`)
3. Open `http://<pi-ip>/` (or mDNS once known) → scan QR → pair
4. Further app updates: NATS `update` command ([commands.md](../../commands.md))

## Layout

```text
tools/image/
  README.md
  build.sh
  config                 # shared pi-gen + CLOUD_BASE_URL default
  config.local.example   # secrets / overrides (copy to config.local)
  stage-dkgm/            # custom stage after Raspberry Pi OS Lite
  .pi-gen/               # gitignored clone
  deploy/                # gitignored build output
```

## Notes

- `tools/` is never part of OTA release zips; only the image build uses this tree.
- Runtime helpers and the systemd unit still live under repo `deploy/` and are
  copied into `/opt/pi-api` during the image build (and later OTA).
