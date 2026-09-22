# Vetura Pi golden image

Build a flashable Raspberry Pi OS Lite (64-bit) image with **vetura-agent**
preinstalled, for **Raspberry Pi 5** and **Raspberry Pi 4 Model B** (one image
boots both). This is the **only** first-install path for devices. App updates
after pairing go over NATS (see [commands.md](../../commands.md)).

The image is an appliance: SSH is **pubkey-only** (your support key), HDMI/serial
have no login, HDMI shows a Plymouth splash then a Chromium kiosk of the local
portal, and root is **LUKS** bound to this Pi + this SD card. Signed
`boot.img` / `boot.sig` are always baked in. The image itself **never** writes
the bootloader EEPROM or the signed-boot OTP fuse: a board is locked to a
signing key per device, out of band, with
[`provision-secure-boot.sh`](#lock-a-device-signed-boot). There is no overlay
filesystem.

There is one image per environment (`staging`, `production`), each signed with
its own key. CI builds them on push (see [CI](#ci)).

| Included | Not included (per device) |
|----------|---------------------------|
| Raspberry Pi OS Lite 64-bit (Trixie), Pi 5 + Pi 4 B | `/var/lib/vetura-agent/state.json` |
| Node.js 20 | `credentials.creds` / NATS pairing |
| `/opt/vetura-agent` + systemd `vetura-agent` enabled | LUKS passphrase (derived from OTP + CID) |
| `/opt/vetura-agent/.env` with `CLOUD_API_URL` / `CLOUD_FRONTEND_URL` | |
| `IMAGE_ENV` (`staging` or `production`) | |
| Support SSH authorized_keys (public key only) | Signing **private** key |
| Signed `boot.img` / `boot.sig` in `/usr/lib/vetura/secure-boot/` | |

## Requirements

- Raspberry Pi **5** or Raspberry Pi **4 Model B** (OTP HMAC via `rpi-fw-crypto`
  + signed boot). Other boards stop at first-boot provision. See
  [Pi 4 notes](#pi-4-notes).
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

`IMAGE_ENV` selects the cloud URLs and the signing key. Both URL pairs live in
`config.local`. The CLI overrides `config.local`.

```bash
cd tools/image
./build.sh                         # staging (default)
IMAGE_ENV=production ./build.sh    # production
```

This will:

1. Resolve `CLOUD_API_URL` / `CLOUD_FRONTEND_URL` from `IMAGE_ENV`
2. Fail if the SSH public key or signing PEM is missing, or the PEM is not the
   private key of `keys/<IMAGE_ENV>.pub.pem`
3. Stage the product package into the pi-gen stage
4. Clone/update [pi-gen](https://github.com/RPi-Distro/pi-gen) (`arm64` branch)
5. Run `build-docker.sh` (Lite stages + `stage-vetura`, including lockdown + signed `boot.img`)
6. Copy artifacts to [`deploy/`](./deploy/)

Output is `deploy/vetura-bridge-<env>-<sha>.img.xz`, e.g.
`vetura-bridge-staging-cecbae2.img.xz`. The sha gets a `-dirty` suffix when
tracked files have uncommitted changes. Older images in `deploy/` are removed
after each successful build (the work container for stage0–2 is still reused on
`CONTINUE`). Keep history with `KEEP_OLD_IMAGES=1`. Full rebuild from stage0:
`CLEAN=1 ./build.sh`.

Either image is safe to flash on any supported Pi as often as you need. First
boot LUKS-encrypts root (bound to this Pi + this SD) and programs the OTP
*device* key. That key is irreversible but does **not** block reflash. Nothing
in the image locks the board.

## Lock a device (signed boot)

Until a board is locked it boots the loose files on the FAT partition, so
anyone with a card reader can change them. Locking makes the bootloader load
only `boot.img`, and only when `boot.sig` was made with your signing key.

This is a per-device step, done **before** the board goes to a customer, with
[`provision-secure-boot.sh`](./provision-secure-boot.sh). It wraps Raspberry
Pi's [usbboot](https://github.com/raspberrypi/usbboot) secure-boot recovery.

1. **Bundle** (needs the private key): a bootloader EEPROM with
   `SIGNED_BOOT=1`, the config signed with your key, and your public key
   embedded. CI builds it from the GitHub secret (see [CI](#ci)); download
   `secure-boot-<board>-<env>-<sha>.tar.gz` and unpack it. Or locally:

   ```bash
   ./provision-secure-boot.sh build --board pi4 --env staging \
     --key ~/.vetura-bridge/secure-boot-staging.pem
   ```

   The bundle holds no secrets (public key and signatures only).

2. **Flash** (needs only the bundle):

   ```bash
   # Pi 4 Model B: write a recovery card, boot the Pi from it once.
   ./provision-secure-boot.sh flash --board pi4 --bundle deploy/secure-boot-pi4-staging \
     --sd /Volumes/RECOVERY

   # Pi 5: hold the power button while plugging USB-C into this computer.
   ./provision-secure-boot.sh flash --board pi5 --bundle deploy/secure-boot-pi5-staging --fuse
   ```

`--fuse` writes the hash of the signing key into the chip (`program_pubkey=1`).
It is **irreversible**, asks for a typed confirmation, and from then on the
board only ever boots images signed with that key.

| | Pi 4 Model B | Pi 5 |
|--|--------------|------|
| Transport | Recovery SD card (no rpiboot jumper) | `rpiboot` over USB-C |
| Without `--fuse` | Works: the EEPROM enforces signed boot. Reversible with Raspberry Pi Imager → Bootloader, so also removable by an attacker with the board in hand | Not possible: a BCM2712 does not start a signed EEPROM without the key hash in OTP. The script refuses |
| With `--fuse` | Permanent. Also turns off SD bootloader recovery: add `--rpiboot-gpio 6` (irreversible too) or the bootloader can never be reflashed | Permanent |
| Re-provision a fused board | `--rpiboot` with the fused GPIO held low | Bundle built with `--sign-recovery`, then `--already-fused` |

**First Pi 4: rehearse before you fuse.** Flash the staging image, let first
boot finish (proves LUKS + `rpi-fw-crypto` on that board), then run `flash`
**without** `--fuse` and check it still boots (proves `boot.img` / `boot.sig`
and the EEPROM). Only then repeat with `--fuse --rpiboot-gpio 6`. On a Pi 5,
rehearse `boot.img` with `boot_ramdisk=1` in `config.txt` instead; there is no
reversible EEPROM step.

Lock **after** first boot has finished. `boot.img` expects the encrypted root
(`root=/dev/mapper/cryptroot`), which exists only after the first-boot encrypt.

A locked board ignores the loose files, so a kernel or firmware update over
`apt` has no effect until a new signed image is flashed.

## CI

[`.github/workflows/image.yml`](../../.github/workflows/image.yml) runs when app
or image files change:

- push to `main`: `production`
- push to any other branch (e.g. `development`): `staging`

Per run it uploads, kept for 30 days:

| Artifact | Made by |
|----------|---------|
| `vetura-bridge-<env>-<sha>.img.xz` | `build.sh` on GitHub's arm64 runners |
| `vetura-bridge-<env>-<sha>-signed-boot.tar.gz` | the image's `boot.img` + `boot.sig`; copy onto a locked board's FAT partition to give it a new signed boot without a reflash |
| `secure-boot-pi4-<env>-<sha>.tar.gz`, `secure-boot-pi5-<env>-<sha>.tar.gz` | `provision-secure-boot.sh build` (signed EEPROM bundle per board) |

This repository is public, so anyone signed in to GitHub can download them. The
signing and SSH private keys are never part of an image or a bundle.

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
2. Boot a **Pi 5** or **Pi 4 Model B** on **Ethernet** (no Wi‑Fi SSID is baked in). HDMI has **no
   login**. A branded Plymouth splash covers boot (including LUKS); kernel/OK
   lines stay hidden. Afterwards HDMI is a Chromium kiosk of the local portal
   (QR). You can still open `http://<ip>/` from another device. Support SSH is
   not shown on the display.
3. First boot takes **several extra minutes** and **reboots more than once**:
   1. OTP device key (one-time, irreversible)
   2. Initramfs LUKS-encrypts the root partition (passphrase = HMAC of OTP key
      + SD CID). The splash shows a progress bar with percentage and an ETA.
      It covers the whole card, so on a Pi 4 (no AES hardware) a 32 GB card
      takes about an hour; a Pi 5 needs a few minutes.
   3. Install signed `boot.img` / `boot.sig` on the FAT partition. The EEPROM
      is left alone; see [Lock a device](#lock-a-device-signed-boot).
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
| Put a tweaked boot back in **this** Pi | Unlocked board: boots. Locked board: signed boot refuses it |
| SSH without your private key | Denied |

## Recovery

- Locked but **not fused** (Pi 4 only): Raspberry Pi Imager → Misc utility images → Bootloader (Pi 4 family) restores the factory EEPROM. Green screen = done.
- **Fused** (`--fuse`): only images signed with the same RSA key will ever boot. Keep both private signing keys offline and backed up. The bootloader can then only be reflashed over `rpiboot` (Pi 4: needs the fused `--rpiboot-gpio`; Pi 5: a bundle built with `--sign-recovery`).
- A locked Pi loads `boot.img` + `boot.sig` from the FAT partition before Linux. A reflash without that pair (or signed with a different PEM) stops at `Error 6` / `Error 12`. The image build puts a ≤128 MB pair on FAT.
- A failed LUKS encrypt (power loss): reflash. Check `/var/log/vetura-provision.log` if the system still boots unsigned.

## Layout

```text
tools/image/
  README.md
  build.sh
  provision-secure-boot.sh  # per-device signed-boot lock (EEPROM bundle + flash)
  config                 # shared pi-gen defaults
  config.local.example   # IMAGE_ENV, cloud URLs, SSH pubkey, signing key path
  keys/                  # public secure-boot keys (staging, production)
  scripts/rpi-eeprom-digest
  stage-vetura/            # Lite + vetura-agent + lockdown + signed boot.img
  .pi-gen/               # gitignored clone
  deploy/                # gitignored build output
```

## Pi 4 notes

- Only the **Pi 4 Model B** is accepted (Pi 400 / CM4 stop at provision).
- First-boot encryption is slower: the BCM2711 has no AES instructions, so
  `aes-xts` runs in software. Expect a longer first boot and lower disk
  throughput than on a Pi 5.
- The Chromium kiosk runs on the firmware framebuffer without GPU. Prefer 4 GB
  boards; 2 GB is tight with Chromium.
- If `rpi-fw-crypto` cannot derive a key on a board, provision stops **before**
  anything is encrypted (`/var/log/vetura-provision.log`); the card stays
  reflashable.

## Notes

- `tools/` is never part of OTA release zips; only the image build uses this tree.
- Runtime helpers and the systemd unit live under repo `packaging/` and are
  copied into `/opt/vetura-agent` during the image build (and later OTA).
