# DKGM Pi golden image

Build a flashable **Raspberry Pi 5** OS Lite (64-bit) image with **dkgm-agent**
preinstalled. This is the **only** first-install path for devices. App updates
after pairing go over NATS (see [commands.md](../../commands.md)).

The image is an appliance: SSH is **pubkey-only** (your support key), HDMI/serial
have no login, root is **LUKS** bound to this Pi + this SD card, and **signed
boot** rejects a tweaked boot partition. There is no overlay filesystem.

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
- [config.local](./config.local.example) with `CLOUD_API_URL`, `CLOUD_FRONTEND_URL`, `PUBKEY_SSH_FIRST_USER`, `SECURE_BOOT_KEY`

On Linux you may need `binfmt` / `qemu-user-static` support so the ARM chroot
works. See the [pi-gen README](https://github.com/RPi-Distro/pi-gen).

## Configure

```bash
# SSH support key (private key stays on the support laptop; never on the SD)
ssh-keygen -t ed25519 -f ~/.ssh/dkgm-support -N ""
# Secure-boot signing key (RSA 2048). Back this up; losing it bricks signed devices.
openssl genrsa 2048 > ./.dkgm-secure-boot.pem
chmod 600 ./.dkgm-secure-boot.pem

cd tools/image
cp config.local.example config.local
# Edit config.local:
#   CLOUD_API_URL        # origin/path only, no ?query (agent appends /api/...)
#   CLOUD_FRONTEND_URL   # origin for QR pair URL (/devices/pair?...)
#   PUBKEY_SSH_FIRST_USER='ssh-ed25519 AAAA... support@dkgm'
#   PUBKEY_ONLY_SSH=1
#   SECURE_BOOT_KEY='/Users/you/.dkgm-secure-boot.pem'
```

`FIRST_USER_PASS` is required by pi-gen. `build.sh` replaces `change-me` with a
random string. It is **not** a login password (`PasswordAuthentication no`).
`PASSWORDLESS_SUDO` stays on so the key-only `dkgm` user can run sudo.

One public key is baked into every card. If that **private** SSH key leaks, every
device is reachable. Rotate by installing a new `authorized_keys` over SSH (or
a new image) and retiring the old key.

The signing PEM is used only on the build machine. It is never copied into the
rootfs.

## Build

```bash
cd tools/image
./build.sh
```

This will:

1. Fail if the SSH public key or signing PEM is missing
2. Stage the product package into the pi-gen stage
3. Clone/update [pi-gen](https://github.com/RPi-Distro/pi-gen) (`arm64` branch)
4. Run `build-docker.sh` (Lite stages + `stage-dkgm`, including lockdown + signed `boot.img`)
5. Copy artifacts to [`deploy/`](./deploy/)

Output is typically `deploy/dkgm-pi-*.img.xz`.

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
- **After** fuse: only images signed with the same RSA key will boot. Keep `secure-boot.pem` offline and backed up.
- A failed LUKS encrypt (power loss): reflash. Check `/var/log/dkgm-provision.log` if the system still boots unsigned.

## Layout

```text
tools/image/
  README.md
  build.sh
  config                 # shared pi-gen defaults
  config.local.example   # secrets / SSH pubkey / signing key path
  scripts/rpi-eeprom-digest
  stage-dkgm/            # Lite + dkgm-agent + lockdown + signed boot.img
  .pi-gen/               # gitignored clone
  deploy/                # gitignored build output
```

## Notes

- `tools/` is never part of OTA release zips; only the image build uses this tree.
- Runtime helpers and the systemd unit live under repo `packaging/` and are
  copied into `/opt/dkgm-agent` during the image build (and later OTA).
