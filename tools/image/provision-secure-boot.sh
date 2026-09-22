#!/usr/bin/env bash
# Lock one Raspberry Pi to a Vetura signing key (signed boot), out of band.
#
#   build  needs the private signing key; makes a bundle with the signed EEPROM.
#          The bundle holds no secrets. CI builds it too (image.yml).
#   flash  needs only the bundle; writes it to one board. --fuse is irreversible.
#
# Wraps https://github.com/raspberrypi/usbboot (secure-boot-recovery{,5}).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USBBOOT_DIR="${USBBOOT_DIR:-${SCRIPT_DIR}/.usbboot}"
USBBOOT_REPO="${USBBOOT_REPO:-https://github.com/raspberrypi/usbboot.git}"
USBBOOT_REF="${USBBOOT_REF:-master}"
WORK=""
trap '[[ -z "${WORK}" ]] || rm -rf "${WORK}"' EXIT

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
provision-secure-boot.sh build --board pi4|pi5 --env staging|production --key <private.pem>
                               [--out <dir>] [--sign-recovery]
provision-secure-boot.sh flash --board pi4|pi5 --bundle <dir>
                               [--sd <mounted FAT32 dir> | --rpiboot]
                               [--fuse] [--rpiboot-gpio 2|4|5|6|7|8] [--already-fused]
                               [--metadata <dir>]

build
  --sign-recovery   pi5 only: also counter-sign recovery.bin (bootcode5.fused.bin),
                    needed to re-provision a Pi 5 that is already fused. Local use;
                    do not publish that file.

flash
  --sd <dir>        pi4 default. Copies recovery files to an empty FAT32 SD card;
                    boot the Pi 4 from it once.
  --rpiboot         USB device boot. pi5 default (hold the power button while
                    plugging USB-C into this computer). On a Pi 4 Model B only
                    after --rpiboot-gpio was fused.
  --fuse            IRREVERSIBLE. Writes the hash of the signing key to OTP
                    (program_pubkey=1). The board then only ever boots images
                    signed with this key. Required on pi5; optional on pi4.
  --rpiboot-gpio N  pi4 only, IRREVERSIBLE. Lets GPIO N (pulled low) force
                    rpiboot. After --fuse this is the only way to recover the
                    Pi 4 bootloader, because SD recovery is disabled.
  --already-fused   pi5 only: use the counter-signed recovery (needs a bundle
                    built with --sign-recovery).
EOF
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required${2:+ ($2)}"
}

fetch_usbboot() {
  need git
  if [[ ! -d "${USBBOOT_DIR}/.git" ]]; then
    git clone --depth 1 --branch "${USBBOOT_REF}" --recurse-submodules --shallow-submodules \
      "${USBBOOT_REPO}" "${USBBOOT_DIR}"
  else
    git -C "${USBBOOT_DIR}" fetch --depth 1 origin "${USBBOOT_REF}"
    git -C "${USBBOOT_DIR}" checkout -q FETCH_HEAD
    git -C "${USBBOOT_DIR}" submodule update --init --depth 1
  fi
}

recovery_dir_for() {
  case "$1" in
    pi4) echo "secure-boot-recovery" ;;
    pi5) echo "secure-boot-recovery5" ;;
    *) die "--board must be pi4 or pi5" ;;
  esac
}

cmd_build() {
  local board="" env="" key="" out="" sign_recovery=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --board) board="$2"; shift 2 ;;
      --env) env="$2"; shift 2 ;;
      --key) key="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --sign-recovery) sign_recovery=1; shift ;;
      *) die "unknown build option: $1" ;;
    esac
  done
  local recovery
  recovery="$(recovery_dir_for "${board}")"
  [[ "${env}" == "staging" || "${env}" == "production" ]] || die "--env must be staging or production"
  [[ -n "${key}" && -f "${key}" ]] || die "--key must be the ${env} private signing PEM"
  [[ "${sign_recovery}" == "0" || "${board}" == "pi5" ]] || die "--sign-recovery is pi5 only"
  out="${out:-${SCRIPT_DIR}/deploy/secure-boot-${board}-${env}}"

  need openssl
  need python3
  need xxd
  need strings binutils
  python3 -c 'import Cryptodome' 2>/dev/null \
    || die "python3 module Cryptodome missing (apt install python3-pycryptodome / pip3 install pycryptodomex)"

  # Same rule as build.sh: never sign for one environment with the other's key.
  local pub="${SCRIPT_DIR}/keys/${env}.pub.pem"
  [[ -f "${pub}" ]] || die "missing ${pub}"
  if [[ "$(openssl pkey -in "${key}" -pubout)" != "$(openssl pkey -pubin -in "${pub}" -pubout)" ]]; then
    die "--key is not the ${env} signing key (${pub})"
  fi
  key="$(cd "$(dirname "${key}")" && pwd)/$(basename "${key}")"

  fetch_usbboot
  WORK="$(mktemp -d)"
  local work="${WORK}"
  # -L: the recovery directories are symlinks into the rpi-eeprom submodule.
  cp -RL "${USBBOOT_DIR}/${recovery}" "${work}/recovery"

  # SD only, no OS-side EEPROM self-update (it would drop the pubkey).
  cat >"${work}/recovery/boot.conf" <<'EOF'
[all]
SIGNED_BOOT=1
BOOT_UART=0
BOOT_ORDER=0xf1
ENABLE_SELF_UPDATE=0
EOF

  (
    cd "${work}/recovery"
    if [[ "${board}" == "pi5" ]]; then
      if [[ "${sign_recovery}" == "1" ]]; then
        "${USBBOOT_DIR}/tools/update-pieeprom.sh" -fr -k "${key}"
        mv bootcode5.bin bootcode5.fused.bin
      fi
      # -f: BCM2712 needs the firmware counter-signed with the customer key.
      "${USBBOOT_DIR}/tools/update-pieeprom.sh" -f -k "${key}"
    else
      "${USBBOOT_DIR}/tools/update-pieeprom.sh" -k "${key}"
    fi
  )

  rm -rf "${out}"
  mkdir -p "${out}"
  cp "${work}/recovery/pieeprom.bin" "${work}/recovery/pieeprom.sig" "${out}/"
  if [[ "${board}" == "pi5" ]]; then
    cp "${work}/recovery/bootcode5.bin" "${out}/"
    if [[ "${sign_recovery}" == "1" ]]; then
      cp "${work}/recovery/bootcode5.fused.bin" "${out}/"
    fi
  else
    # rpiboot wants bootcode4.bin, the SD card wants recovery.bin. Same file.
    cp "${work}/recovery/bootcode4.bin" "${out}/bootcode4.bin"
    cp "${work}/recovery/bootcode4.bin" "${out}/recovery.bin"
  fi
  printf '%s\n' "${board}" >"${out}/BOARD"
  printf '%s\n' "${env}" >"${out}/ENV"
  git -C "${USBBOOT_DIR}" rev-parse HEAD >"${out}/USBBOOT_COMMIT"

  if grep -rl "PRIVATE KEY" "${out}" >/dev/null 2>&1; then
    rm -rf "${out}"
    die "private key material ended up in the bundle; aborted"
  fi
  echo "Bundle: ${out}"
}

confirm_irreversible() {
  local board="$1" env="$2" what="$3"
  cat >&2 <<EOF

  IRREVERSIBLE: ${what}
  Board: ${board}   Signing key: ${env}
  This changes the chip itself. A new SD card does not undo it. If the ${env}
  private key is ever lost, this board can never boot a new image again.

EOF
  local answer
  read -r -p "  Type 'fuse ${board} ${env}' to continue: " answer
  [[ "${answer}" == "fuse ${board} ${env}" ]] || die "not confirmed; nothing was written"
}

cmd_flash() {
  local board="" bundle="" sd="" use_rpiboot=0 fuse=0 gpio="" already_fused=0 metadata=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --board) board="$2"; shift 2 ;;
      --bundle) bundle="$2"; shift 2 ;;
      --sd) sd="$2"; shift 2 ;;
      --rpiboot) use_rpiboot=1; shift ;;
      --fuse) fuse=1; shift ;;
      --rpiboot-gpio) gpio="$2"; shift 2 ;;
      --already-fused) already_fused=1; shift ;;
      --metadata) metadata="$2"; shift 2 ;;
      *) die "unknown flash option: $1" ;;
    esac
  done
  recovery_dir_for "${board}" >/dev/null
  [[ -d "${bundle}" && -f "${bundle}/pieeprom.bin" && -f "${bundle}/pieeprom.sig" ]] \
    || die "--bundle must be a directory made by 'build'"
  [[ "$(cat "${bundle}/BOARD")" == "${board}" ]] || die "bundle is for $(cat "${bundle}/BOARD"), not ${board}"
  local env
  env="$(cat "${bundle}/ENV")"

  if [[ "${board}" == "pi5" ]]; then
    [[ -z "${sd}" ]] || die "pi5 is provisioned over rpiboot, not --sd"
    [[ -z "${gpio}" ]] || die "--rpiboot-gpio is pi4 only"
    use_rpiboot=1
    # A BCM2712 without the key hash in OTP does not start a signed EEPROM at all.
    if [[ "${fuse}" == "0" && "${already_fused}" == "0" ]]; then
      die "pi5 cannot run a signed EEPROM without the OTP fuse: pass --fuse (or --already-fused). To rehearse without fusing, put boot.img + boot.sig on the boot partition and set boot_ramdisk=1 in config.txt."
    fi
  else
    [[ "${already_fused}" == "0" ]] || die "--already-fused is pi5 only"
    if [[ -n "${gpio}" ]]; then
      case "${gpio}" in 2|4|5|6|7|8) ;; *) die "--rpiboot-gpio must be one of 2 4 5 6 7 8" ;; esac
    fi
    if [[ "${use_rpiboot}" == "0" && -z "${sd}" ]]; then
      die "pi4: pass --sd <mounted FAT32 dir> (or --rpiboot if the rpiboot GPIO is fused)"
    fi
    [[ "${use_rpiboot}" == "0" || -z "${sd}" ]] || die "pick one of --sd and --rpiboot"
    if [[ "${fuse}" == "1" && -z "${gpio}" ]]; then
      echo "warning: --fuse without --rpiboot-gpio: after the fuse, SD recovery is off and this Pi 4 has no way left to reflash its bootloader." >&2
    fi
  fi

  [[ "${fuse}" == "0" ]] || confirm_irreversible "${board}" "${env}" "program_pubkey=1 (signed boot locked to this key forever)"
  [[ -z "${gpio}" ]] || confirm_irreversible "${board}" "${env}" "program_rpiboot_gpio=${gpio} (GPIO ${gpio} low at power-on forces rpiboot forever)"

  WORK="$(mktemp -d)"
  local work="${WORK}"
  cp "${bundle}/pieeprom.bin" "${bundle}/pieeprom.sig" "${work}/"
  {
    echo "uart_2ndstage=1"
    [[ "${fuse}" == "0" ]] || echo "program_pubkey=1"
    [[ -z "${gpio}" ]] || echo "program_rpiboot_gpio=${gpio}"
  } >"${work}/config.txt"

  if [[ "${board}" == "pi5" ]]; then
    if [[ "${already_fused}" == "1" ]]; then
      [[ -f "${bundle}/bootcode5.fused.bin" ]] || die "bundle has no bootcode5.fused.bin (build with --sign-recovery)"
      cp "${bundle}/bootcode5.fused.bin" "${work}/bootcode5.bin"
    else
      cp "${bundle}/bootcode5.bin" "${work}/bootcode5.bin"
    fi
  elif [[ "${use_rpiboot}" == "1" ]]; then
    cp "${bundle}/bootcode4.bin" "${work}/bootcode4.bin"
  else
    cp "${bundle}/recovery.bin" "${work}/recovery.bin"
  fi

  if [[ -n "${sd}" ]]; then
    [[ -d "${sd}" ]] || die "--sd ${sd} is not a directory"
    # Windows adds a hidden "System Volume Information" folder to every FAT card.
    if [[ -n "$(ls -A "${sd}" 2>/dev/null | grep -v '^System Volume Information$')" ]]; then
      die "--sd ${sd} is not empty; use a freshly formatted FAT32 card"
    fi
    # recovery.bin on an SD card loads pieeprom.upd; the .bin name is for rpiboot.
    mv "${work}/pieeprom.bin" "${work}/pieeprom.upd"
    cp "${work}/"* "${sd}/"
    sync 2>/dev/null || true
    cat <<EOF
Recovery card written to ${sd}. Eject it, then:
  1. Power the Pi 4 off, insert this card, power on.
  2. Success: green LED blinks fast and steady (HDMI shows a green screen).
     Failure: a repeating long/short blink pattern (HDMI red). Do not continue.
  3. Power off, swap in the image card (it carries boot.img + boot.sig).
EOF
    [[ "${fuse}" == "1" ]] || echo "Not fused: undo with Raspberry Pi Imager > Misc utility images > Bootloader (Pi 4 family)."
    return 0
  fi

  fetch_usbboot
  need make
  if [[ ! -x "${USBBOOT_DIR}/rpiboot" ]]; then
    make -C "${USBBOOT_DIR}" || die "building rpiboot failed (needs libusb-1.0 dev headers and pkg-config)"
  fi
  metadata="${metadata:-${SCRIPT_DIR}/provisioned}"
  mkdir -p "${metadata}"
  if [[ "${board}" == "pi5" ]]; then
    echo "Pi 5: hold the power button, plug USB-C into this computer, release."
  else
    echo "Pi 4: hold the rpiboot GPIO low, then power on over USB-C from this computer."
  fi
  # May need sudo on Linux without the usbboot udev rule.
  "${USBBOOT_DIR}/rpiboot" -d "${work}" -j "${metadata}"
  echo "Done. Device record (serial, CUSTOMER_KEY_HASH) is in ${metadata}/."
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  flash) shift; cmd_flash "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; exit 1 ;;
esac
