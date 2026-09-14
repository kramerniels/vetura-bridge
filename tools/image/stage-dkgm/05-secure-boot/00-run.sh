#!/bin/bash -e
# Pack /boot/firmware into boot.img (in the target), sign on the build host.
# The RSA PEM is never copied into the rootfs.

KEY="${BASE_DIR}/.dkgm-sb-key.pem"
DIGEST="${BASE_DIR}/dkgm-rpi-eeprom-digest"
OUT_REL=/usr/lib/dkgm/secure-boot
OUT="${ROOTFS_DIR}${OUT_REL}"
BOOT_SRC="${ROOTFS_DIR}/boot/firmware"

if [[ ! -f "${KEY}" ]]; then
	echo "Missing signing key at ${KEY}" >&2
	echo "build.sh copies SECURE_BOOT_KEY there; it must not be inside the rootfs." >&2
	exit 1
fi

if [[ ! -d "${BOOT_SRC}" ]]; then
	echo "Missing ${BOOT_SRC}" >&2
	exit 1
fi

if [[ ! -x "${DIGEST}" ]]; then
	echo "Missing signer ${DIGEST} (build.sh copies tools/image/scripts/rpi-eeprom-digest)" >&2
	exit 1
fi

install -d -m 0755 "${OUT}"
rm -rf "${ROOTFS_DIR}/tmp/dkgm-bootimg-src"
install -d "${ROOTFS_DIR}/tmp/dkgm-bootimg-src"
cp -a "${BOOT_SRC}/." "${ROOTFS_DIR}/tmp/dkgm-bootimg-src/"

cfg="${ROOTFS_DIR}/tmp/dkgm-bootimg-src/config.txt"
if [[ -f "${cfg}" ]]; then
	if ! grep -q '^program_pubkey=' "${cfg}"; then
		printf '\nprogram_pubkey=1\nlock_device_private_key=1\n' >>"${cfg}"
	fi
	if ! grep -q 'dtoverlay=dkgm-disable-v3d' "${cfg}"; then
		printf '\ndtoverlay=dkgm-disable-v3d\n' >>"${cfg}"
	fi
else
	printf 'program_pubkey=1\nlock_device_private_key=1\ndtoverlay=dkgm-disable-v3d\n' >"${cfg}"
fi

# Size the FAT image to the payload. A padded 256M file would not fit on the
# 512M bootfs together with the loose firmware files used for first (unfused) boot.
need_kb="$(du -sk "${ROOTFS_DIR}/tmp/dkgm-bootimg-src" | awk '{print $1}')"
need_mb="$(( (need_kb + 1023) / 1024 + 32 ))"
if [[ "${need_mb}" -lt 64 ]]; then
	need_mb=64
fi
if [[ "${need_mb}" -gt 280 ]]; then
	echo "boot.img would be ${need_mb}M; too large for a 512M boot partition" >&2
	exit 1
fi

on_chroot << EOF
set -e
OUT=/usr/lib/dkgm/secure-boot
SRC=/tmp/dkgm-bootimg-src
mkdir -p "\${OUT}"
rm -f "\${OUT}/boot.img"
truncate -s ${need_mb}M "\${OUT}/boot.img"
mkfs.vfat -n RPIBOOT "\${OUT}/boot.img"
mcopy -i "\${OUT}/boot.img" -s "\${SRC}"/* ::
rm -rf /tmp/dkgm-bootimg-src
EOF

if ! command -v openssl >/dev/null 2>&1; then
	apt-get update
	apt-get install -y --no-install-recommends openssl
fi
"${DIGEST}" -i "${OUT}/boot.img" -o "${OUT}/boot.sig" -k "${KEY}"
if ! grep -Eq '^rsa2048: [0-9a-fA-F]{512}$' "${OUT}/boot.sig"; then
	echo "boot.sig is not a valid Raspberry Pi RSA-2048 signature" >&2
	exit 1
fi
chmod 0644 "${OUT}/boot.img" "${OUT}/boot.sig"
# Fused Pis only load this pair from the FAT boot partition. Leaving it solely
# under /usr/lib/dkgm/secure-boot meant a reflash could not boot (Error 6).
install -m 0644 "${OUT}/boot.img" "${BOOT_SRC}/boot.img"
install -m 0644 "${OUT}/boot.sig" "${BOOT_SRC}/boot.sig"

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

pieeprom=""
for dir in \
	"${ROOTFS_DIR}/usr/lib/firmware/raspberrypi/bootloader-2712/latest" \
	"${ROOTFS_DIR}/usr/lib/firmware/raspberrypi/bootloader-2712/default" \
	"${ROOTFS_DIR}/lib/firmware/raspberrypi/bootloader-2712/latest"; do
	if [[ -d "${dir}" ]]; then
		pieeprom=$(ls "${dir}"/pieeprom*.bin 2>/dev/null | tail -1 || true)
		[[ -n "${pieeprom}" ]] && break
	fi
done

cfgbin=""
if [[ -x "${ROOTFS_DIR}/usr/bin/rpi-eeprom-config" ]]; then
	cfgbin="${ROOTFS_DIR}/usr/bin/rpi-eeprom-config"
fi

if [[ -n "${pieeprom}" && -n "${cfgbin}" ]]; then
	cat >"${tmp}/boot.conf" <<'EOM'
[all]
SIGNED_BOOT=1
BOOT_UART=0
EOM
	if "${cfgbin}" --config "${tmp}/boot.conf" --out "${tmp}/pieeprom.bin" "${pieeprom}"; then
		"${DIGEST}" -i "${tmp}/pieeprom.bin" -o "${OUT}/pieeprom.sig" -k "${KEY}"
		cp "${tmp}/pieeprom.bin" "${OUT}/pieeprom.bin"
		chmod 0644 "${OUT}/pieeprom.bin" "${OUT}/pieeprom.sig"
	else
		echo "Warning: could not wrap pieeprom; first-boot will still install boot.img" >&2
	fi
else
	echo "Warning: no 2712 pieeprom / rpi-eeprom-config in rootfs; EEPROM not pre-signed" >&2
fi

rm -f "${ROOTFS_DIR}/.dkgm-sb-key.pem" "${OUT}/"*.pem
