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
	if ! grep -q 'dtoverlay=dkgm-disable-v3d' "${cfg}"; then
		printf '\ndtoverlay=dkgm-disable-v3d\n' >>"${cfg}"
	fi
else
	printf 'dtoverlay=dkgm-disable-v3d\n' >"${cfg}"
fi

on_chroot << 'EOF'
set -e
OUT=/usr/lib/dkgm/secure-boot
SRC=/tmp/dkgm-bootimg-src
mkdir -p "${OUT}"
rm -f "${OUT}/boot.img"
# Pi 4/5 ramdisk max is 180MB; a 256MB file is truncated and fails as Error 12.
truncate -s 128M "${OUT}/boot.img"
mkfs.vfat -F 32 -n RPIBOOT "${OUT}/boot.img"
mcopy -i "${OUT}/boot.img" -s "${SRC}"/* ::
rm -rf /tmp/dkgm-bootimg-src
EOF

"${DIGEST}" -i "${OUT}/boot.img" -o "${OUT}/boot.sig" -k "${KEY}"
chmod 0644 "${OUT}/boot.img" "${OUT}/boot.sig"
# Fused devices load only this pair from FAT. Provision also copies it later,
# but a reflash never reaches Linux unless it is already on the boot partition.
install -m 0644 "${OUT}/boot.img" "${BOOT_SRC}/boot.img"
install -m 0644 "${OUT}/boot.sig" "${BOOT_SRC}/boot.sig"

# Do not wrap a SIGNED_BOOT=1 pieeprom here. On Pi 5 that flag without the
# customer pubkey in EEPROM (only possible via rpiboot recovery) requires
# boot.img then fails verify (Error 12). First-boot must not lock the EEPROM.
rm -f "${ROOTFS_DIR}/.dkgm-sb-key.pem" "${OUT}/"*.pem "${OUT}/pieeprom.bin" "${OUT}/pieeprom.sig"
