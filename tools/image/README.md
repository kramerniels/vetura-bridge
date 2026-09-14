# DKGM Pi golden image

Build a flashable **Raspberry Pi 5** OS Lite (64-bit) image with **dkgm-agent**
preinstalled. This is the **only** first-install path for devices. App updates
after pairing go over NATS (see [commands.md](../../commands.md)).

The image is an appliance: SSH is **pubkey-only** (your support key), HDMI/serial
have no login, root is **LUKS** bound to this Pi + this SD card, and **signed
boot** rejects a tweaked boot partition. There is no overlay filesystem.

There is one image per environment (`staging`, `production`), each signed with
its own key. CI builds them on push (see [CI](#ci)).

| Included | Not included (per device) |
|----------|---------------------------|
| Raspberry Pi OS Lite 64-bit (Trixie), Pi 5 | `/var/lib/dkgm-agent/state.json` |
| Node.js 20 | `credentials.creds` / NATS pairing |
| `/opt/dkgm-agent` + systemd `dkgm-agent` enabled | LUKS passphrase (derived from OTP + CID) |
| `/opt/dkgm-agent/.env` with `CLOUD_API_URL` / `CLOUD_FRONTEND_URL` | |
| Support SSH authorized_keys (public key only) | Signing **private** key |
| Signed `boot.img` / `boot.sig` in `/usr/lib/dkgm/secure-boot/` | |

## Requirements

- Raspberry Pi **5** (OTP HMAC + signed boot). Do not flash this image on Pi 4/3.
- Docker (Linux or macOS; privileged containers + `binfmt` for ARM)
- Git, OpenSSL
- Enough disk for pi-gen work dirs (tens of GB)
- [config.local](./config.local.example) with `IMAGE_ENV`, `CLOUD_API_URL`, `CLOUD_FRONTEND_URL`, `PUBKEY_SSH_FIRST_USER`, `SECURE_BOOT_KEY`

On Linux you may need `binfmt` / `qemu-user-static` support so the ARM chroot
works. See the [pi-gen README](https://github.com/RPi-Distro/pi-gen).

## Configure

```bash
# SSH support key (private key stays on the support laptop; never on the SD)
ssh-keygen -t ed25519 -f ~/.ssh/dkgm-support -N ""

cd tools/image
cp config.local.example config.local
# Edit config.local:
#   IMAGE_ENV='staging'  # or 'production'
#   CLOUD_API_URL        # origin/path only, no ?query (agent appends /api/...)
#   CLOUD_FRONTEND_URL   # origin for QR pair URL (/devices/pair?...)
#   PUBKEY_SSH_FIRST_USER='ssh-ed25519 AAAA... support@dkgm'
#   PUBKEY_ONLY_SSH=1
#   SECURE_BOOT_KEY='/Users/you/.vetura-bridge/secure-boot-staging.pem'
```

`FIRST_USER_PASS` is required by pi-gen. `build.sh` replaces `change-me` with a
random string. It is **not** a login password (`PasswordAuthentication no`).
`PASSWORDLESS_SUDO` stays on so the key-only `dkgm` user can run sudo.

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

```bash
cd tools/image
./build.sh
```

This will:

1. Fail if `IMAGE_ENV`, a cloud URL, the SSH public key or the signing PEM is missing, or the PEM does not match `keys/<IMAGE_ENV>.pub.pem`
2. Stage the product package into the pi-gen stage
3. Clone/update [pi-gen](https://github.com/RPi-Distro/pi-gen) (`arm64` branch)
4. Run `build-docker.sh` (Lite stages + `stage-dkgm`, including lockdown + signed `boot.img`)
5. Copy artifacts to [`deploy/`](./deploy/)

Output is `deploy/vetura-bridge-<env>-<sha>.img.xz`, e.g.
`vetura-bridge-staging-cecbae2.img.xz`. The sha gets a `-dirty` suffix when
tracked files have uncommitted changes.

If a previous run was killed mid-`apt`, the next `./build.sh` reuses the Docker
work container and repairs `dpkg` first. For a full rebuild (drops the cached
Lite stages too):

```bash
CLEAN=1 ./build.sh
```

## CI

[`.github/workflows/image.yml`](../../.github/workflows/image.yml) runs `build.sh`
on GitHub's arm64 runners when app or image files change:

- push to `main`: `production` image
- push to any other branch (e.g. `development`): `staging` image

Each image is uploaded as a workflow artifact named `vetura-bridge-<env>-<sha>.img.xz`
and kept for 30 days. This repository is public, so anyone signed in to GitHub can
download them. The signing and SSH private keys are never part of the image.

Each GitHub environment (**Settings → Environments** → `staging` / `production`) needs:

| Name | Kind | Value |
|------|------|-------|
| `CLOUD_API_URL` | variable | Cloud API origin of that environment |
| `CLOUD_FRONTEND_URL` | variable | Cloud frontend origin of that environment (QR pair link) |
| `SUPPORT_SSH_PUBKEY` | variable | Support SSH public key (`ssh-ed25519 AAAA...`) |
| `SECURE_BOOT_KEY` | secret | Private signing PEM of that environment |

Limit the `production` environment to the `main` branch (**Deployment branches and
tags**), so no other branch can use its key.

## Flash and first boot

1. Write the image to an SD card (Raspberry Pi Imager, Etcher, `dd`)
2. Boot a **Pi 5** on **Ethernet** (no Wi‑Fi SSID is baked in). HDMI has **no
   login**: the last systemd line (often `cloud-init.target`) stays on screen.
   That is not a hang. Find the IP on your router and open `http://<ip>/` or SSH.
3. First boot takes **several extra minutes** and **reboots more than once**:
   1. OTP device key (one-time, irreversible)
   2. Initramfs LUKS-encrypts the root partition (passphrase = HMAC of OTP key + SD CID)
   3. Install signed `boot.img` + EEPROM (`SIGNED_BOOT`); `program_pubkey=1` fuses the customer key
4. When provision has finished (`/boot/firmware/dkgm-provision.done`), the portal is
   on port 80: `http://<pi-ip>/` or mDNS → scan QR → pair
5. Further app updates: NATS `update` ([commands.md](../../commands.md)) — files
   live on the unlocked LUKS volume and persist.

Support SSH (after provision):

```bash
ssh -i ~/.ssh/dkgm-support dkgm@<pi-ip>
```

HDMI and serial have **no login prompt**. Kernel messages may still appear.

## What a user with a card reader can and cannot do

| Action | Result |
|--------|--------|
| Mount the FAT boot partition | Visible (firmware, `boot.img`). Cannot forge a valid `boot.sig` without your signing key. |
| Mount root on a PC | LUKS; no files without this Pi's OTP key |
| Put a tweaked boot back in **this** Pi | Signed boot refuses it (after OTP fuse) |
| SSH without your private key | Denied |

## Recovery

- **Before** signed-boot OTP fuse: reflash the SD card.
- **After** fuse (`secure-boot: flags 1` on the diagnostic screen): the FAT partition must contain `boot.img` + `boot.sig` signed with the **same** RSA key that was fused. A new PEM will not boot that Pi. Keep both private signing keys offline and backed up. Error 6 loading `boot.img` means the pair is missing, unreadable, or signed with the wrong key.
- Unplug extra USB storage while flashing/booting; the bootloader may try USB-MSD before the SD slot is useful.
- A failed LUKS encrypt (power loss): reflash. Check `/var/log/dkgm-provision.log` if the system still boots unsigned.

## Layout

```text
tools/image/
  README.md
  build.sh
  config                 # shared pi-gen defaults
  config.local.example   # environment / SSH pubkey / signing key path
  keys/                  # public secure-boot keys (staging, production)
  scripts/rpi-eeprom-digest
  stage-dkgm/            # Lite + dkgm-agent + lockdown + signed boot.img
  .pi-gen/               # gitignored clone
  deploy/                # gitignored build output
```

## Notes

- `tools/` is never part of OTA release zips; only the image build uses this tree.
- Runtime helpers and the systemd unit live under repo `packaging/` and are
  copied into `/opt/dkgm-agent` during the image build (and later OTA).
