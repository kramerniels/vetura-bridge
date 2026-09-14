# Vetura Pi golden image

Build a flashable **Raspberry Pi 5** OS Lite (64-bit) image with **vetura-agent**
preinstalled. This is the **only** first-install path for devices. App updates
after pairing go over NATS (see [commands.md](../../commands.md)).

The image is an appliance: SSH is **pubkey-only** (your support key), HDMI/serial
have no login, HDMI shows a Plymouth splash then a Chromium kiosk of the local
portal, and root is **LUKS** bound to this Pi + this SD card. Signed
`boot.img` / `boot.sig` are always baked in. A **staging** image does not lock
the EEPROM; a **production** image enables `SIGNED_BOOT` on first boot. There
is no overlay filesystem.

There is one image per environment (`staging`, `production`), each signed with
its own key. CI builds them on push (see [CI](#ci)).

| Included | Not included (per device) |
|----------|---------------------------|
| Raspberry Pi OS Lite 64-bit (Trixie), Pi 5 | `/var/lib/vetura-agent/state.json` |
| Node.js 20 | `credentials.creds` / NATS pairing |
| `/opt/vetura-agent` + systemd `vetura-agent` enabled | LUKS passphrase (derived from OTP + CID) |
| `/opt/vetura-agent/.env` with `CLOUD_API_URL` / `CLOUD_FRONTEND_URL` | |
| `IMAGE_ENV` (`staging` or `production`) | |
| Support SSH authorized_keys (public key only) | Signing **private** key |
| Signed `boot.img` / `boot.sig` in `/usr/lib/vetura/secure-boot/` | |

## Requirements

- Raspberry Pi **5** (OTP HMAC + signed boot). Do not flash this image on Pi 4/3.
- Docker (Linux or macOS; privileged containers + `binfmt` for ARM)
- Git, OpenSSL
- Enough disk for pi-gen work dirs (tens of GB)
- [config.local](./config.local.example) with `IMAGE_ENV`, staging/production `CLOUD_*` URLs, `PUBKEY_SSH_FIRST_USER`, `SECURE_BOOT_KEY`

On Linux you may need `binfmt` / `qemu-user-static` support so the ARM chroot
works. See the [pi-gen README](https://github.com/RPi-Distro/pi-gen).

## Configure

```bash
# SSH support key (private key stays on the support laptop; never on the SD)
ssh-keygen -t ed25519 -f ~/.ssh/vetura-support -N ""

cd tools/image
cp config.local.example config.local
# Edit config.local:
#   IMAGE_ENV=staging    # or production; CLI IMAGE_ENV=… ./build.sh wins
#   STAGING_CLOUD_API_URL / STAGING_CLOUD_FRONTEND_URL
#   PRODUCTION_CLOUD_API_URL / PRODUCTION_CLOUD_FRONTEND_URL
#   PUBKEY_SSH_FIRST_USER='ssh-ed25519 AAAA... support@vetura'
#   PUBKEY_ONLY_SSH=1
#   SECURE_BOOT_KEY='/Users/you/.vetura-bridge/secure-boot-staging.pem'
```

`FIRST_USER_PASS` is required by pi-gen. `build.sh` replaces `change-me` with a
random string. It is **not** a login password (`PasswordAuthentication no`).
`PASSWORDLESS_SUDO` stays on so the key-only `vetura` user can run sudo.

One public key is baked into every card. If that **private** SSH key leaks, every
device is reachable. Rotate by installing a new `authorized_keys` over SSH (or
a new image) and retiring the old key.

### Signing keys

Staging and production each have their own RSA 2048 secure-boot key. A Pi only
boots images signed with the key it was provisioned with, so a staging device
never runs a production image, and the other way around.

- The public keys are committed in [`keys/`](./keys/) (`staging.pub.pem`,
  `production.pub.pem`). `build.sh` refuses to build when `SECURE_BOOT_KEY` is
  not the private key of `keys/<IMAGE_ENV>.pub.pem`.
- The private keys **never** go in git (this repository is public). They live in
  the GitHub environment secrets and in an offline backup: GitHub secrets cannot
  be read back, and losing a key means its devices never get a new signed boot image.
- The signing PEM is used only on the build machine. It is never copied into the
  rootfs.

New key for an environment (devices already provisioned keep requiring the old one):

```bash
openssl genrsa -out secure-boot-staging.pem 2048
openssl pkey -in secure-boot-staging.pem -pubout -out tools/image/keys/staging.pub.pem
```

## Build

`IMAGE_ENV` selects cloud URLs and whether first boot locks signed boot.
Both URL pairs live in `config.local`. The CLI overrides `config.local`.

```bash
cd tools/image
./build.sh                         # staging (default)
IMAGE_ENV=production ./build.sh    # production
```

This will:

1. Resolve `CLOUD_API_URL` / `CLOUD_FRONTEND_URL` from `IMAGE_ENV`
2. Fail if the SSH public key or signing PEM is missing
3. Stage the product package into the pi-gen stage
4. Clone/update [pi-gen](https://github.com/RPi-Distro/pi-gen) (`arm64` branch)
5. Run `build-docker.sh` (Lite stages + `stage-vetura`, including lockdown + signed `boot.img`)
6. Copy artifacts to [`deploy/`](./deploy/)

Output is typically `deploy/image_*-vetura-pi-staging-lite.img.xz` or
`…-vetura-pi-production-lite.img.xz`. Older dated `.img.xz` files in `deploy/`
are removed after each successful build (the work container for stage0–2 is
still reused on `CONTINUE`). Keep history with `KEEP_OLD_IMAGES=1`.
Full rebuild from stage0: `CLEAN=1 ./build.sh`.

### Staging (`IMAGE_ENV=staging`)

Default. Use this while iterating. You can flash the same Pi as often as you
need. First boot does **not** enable `SIGNED_BOOT`.

```bash
cd tools/image
./build.sh
```

Bakes `STAGING_CLOUD_API_URL` / `STAGING_CLOUD_FRONTEND_URL` into
`/opt/vetura-agent/.env`. First boot still LUKS-encrypts root (bound to this
Pi + this SD) and may program the OTP device key. That key is irreversible but
does **not** block reflash.

Signed `boot.img` / `boot.sig` are already in the image as preparation. The
EEPROM stays unlocked.

### Production (`IMAGE_ENV=production`)

Bakes production cloud URLs **and** locks the board on first boot: provision
installs `boot.img` / `boot.sig` and flashes a pieeprom with `SIGNED_BOOT=1`.

```bash
cd tools/image
IMAGE_ENV=production ./build.sh
```

1. Choose **one** RSA 2048 PEM (`SECURE_BOOT_KEY`) and back it up offline.
   After OTP fuse you cannot switch keys.
2. Set `PRODUCTION_CLOUD_API_URL` / `PRODUCTION_CLOUD_FRONTEND_URL` in
   `config.local`.
3. On Pi 5, program the customer public key into the EEPROM with `rpiboot` /
   `rpi-sb-provisioner` **before** flashing this image. `program_pubkey=1`
   inside `boot.img` does not fuse the key on Pi 5.
4. Flash and boot. First boot enables `SIGNED_BOOT`. After that, only images
   signed with the same PEM boot.

Flashing a production image **without** that pubkey stops at Error 12. Recover
with Raspberry Pi Imager → Misc utility images → Bootloader (Pi 5 family)
**unless** OTP is already fused. Do not use a production image on a debug Pi.

## CI

[`.github/workflows/image.yml`](../../.github/workflows/image.yml) runs `build.sh`
on GitHub's arm64 runners when app or image files change:

- push to any branch: `staging` image
- push to `main`: `staging` and `production` images

Each image is uploaded as a workflow artifact named `vetura-bridge-<env>-<sha>.img.xz`
and kept for 30 days. This repository is public, so anyone signed in to GitHub can
download them. The signing and SSH private keys are never part of the image.

Each GitHub environment (**Settings → Environments** → `staging` / `production`) needs:

| Name | Kind | Value |
|------|------|-------|
| `CLOUD_BASE_URL` | variable | Online app URL of that environment |
| `SUPPORT_SSH_PUBKEY` | variable | Support SSH public key (`ssh-ed25519 AAAA...`) |
| `SECURE_BOOT_KEY` | secret | Private signing PEM of that environment |

Limit the `production` environment to the `main` branch (**Deployment branches and
tags**), so no other branch can use its key.

## Flash and first boot

1. Write the image to an SD card (Raspberry Pi Imager, Etcher, `dd`)
2. Boot a **Pi 5** on **Ethernet** (no Wi‑Fi SSID is baked in). HDMI has **no
   login**. A branded Plymouth splash covers boot (including LUKS); kernel/OK
   lines stay hidden. Afterwards HDMI is a Chromium kiosk of the local portal
   (QR). You can still open `http://<ip>/` from another device. Support SSH is
   not shown on the display.
3. First boot takes **several extra minutes** and **reboots more than once**:
   1. OTP device key (one-time, irreversible)
   2. Initramfs LUKS-encrypts the root partition (passphrase = HMAC of OTP key + SD CID)
   3. Install signed `boot.img` / `boot.sig` on the FAT partition. Staging
      leaves the EEPROM unlocked. Production schedules a pieeprom update with
      `SIGNED_BOOT=1` (needs the customer pubkey already in EEPROM via
      `rpiboot`; otherwise Error 12).
4. When provision has finished (`/boot/firmware/vetura-provision.done`), the portal is
   on port 80: `http://<pi-ip>/` or mDNS → scan QR → pair
5. Further app updates: NATS `update` ([commands.md](../../commands.md)) — files
   live on the unlocked LUKS volume and persist.

Support SSH (after provision):

```bash
ssh -i ~/.ssh/vetura-support vetura@<pi-ip>
```

HDMI and serial have **no login prompt**. Plymouth shows the clinic logo until the
portal is up; then Chromium kiosk on the firmware framebuffer (no GPU). Support
SSH still works with your key; it is not shown on the display.

## What a user with a card reader can and cannot do

| Action | Result |
|--------|--------|
| Mount the FAT boot partition | Visible (firmware, `boot.img`). Cannot forge a valid `boot.sig` without your signing key. |
| Mount root on a PC | LUKS; no files without this Pi's OTP key |
| Put a tweaked boot back in **this** Pi | Staging: boots. Production (after first-boot lock): signed boot refuses it |
| SSH without your private key | Denied |

## Recovery

- EEPROM `SIGNED_BOOT` without a pubkey: Raspberry Pi Imager → Misc utility images → Bootloader (Pi 5 family). Green screen = factory EEPROM.
- **After** a real OTP fuse (`program_pubkey` via `rpiboot`): only images signed with the same RSA key will boot. Keep `secure-boot.pem` offline and backed up.
- A fused Pi loads `boot.img` + `boot.sig` from the FAT partition before Linux. A reflash without that pair (or signed with a different PEM) stops at `Error 6` / `Error 12`. The image build puts a ≤128 MB pair on FAT.
- A failed LUKS encrypt (power loss): reflash. Check `/var/log/vetura-provision.log` if the system still boots unsigned.

## Layout

```text
tools/image/
  README.md
  build.sh
  config                 # shared pi-gen defaults
  config.local.example   # IMAGE_ENV, cloud URLs, SSH pubkey, signing key path
  keys/                  # public secure-boot keys (staging, production)
  scripts/rpi-eeprom-digest
  stage-vetura/            # Lite + vetura-agent + lockdown + signed boot.img
  .pi-gen/               # gitignored clone
  deploy/                # gitignored build output
```

## Notes

- `tools/` is never part of OTA release zips; only the image build uses this tree.
- Runtime helpers and the systemd unit live under repo `packaging/` and are
  copied into `/opt/vetura-agent` during the image build (and later OTA).
