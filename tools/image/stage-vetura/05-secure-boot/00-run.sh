#!/bin/bash -e
# Pack /boot/firmware into boot.img (in the target), sign on the build host.
# The RSA PEM is never copied into the rootfs.

KEY="${BASE_DIR}/.vetura-sb-key.pem"
DIGEST="${BASE_DIR}/vetura-rpi-eeprom-digest"
OUT_REL=/usr/lib/vetura/secure-boot
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
rm -rf "${ROOTFS_DIR}/tmp/vetura-bootimg-src"
install -d "${ROOTFS_DIR}/tmp/vetura-bootimg-src"
cp -a "${BOOT_SRC}/." "${ROOTFS_DIR}/tmp/vetura-bootimg-src/"

cfg="${ROOTFS_DIR}/tmp/vetura-bootimg-src/config.txt"
if [[ ! -f "${cfg}" ]]; then
	: >"${cfg}"
fi
if ! grep -q 'dtoverlay=vetura-disable-v3d' "${cfg}"; then
	printf '\ndtoverlay=vetura-disable-v3d\n' >>"${cfg}"
fi
# Production only: ask the bootloader to fuse the customer pubkey. On Pi 5 this
# does not replace rpiboot; without a pubkey already in EEPROM, SIGNED_BOOT=1
# stops at Error 12.
if [[ "${LOCK_SIGNED_BOOT:-}" == "1" ]]; then
	if ! grep -q '^program_pubkey=' "${cfg}"; then
		printf '\nprogram_pubkey=1\nlock_device_private_key=1\n' >>"${cfg}"
	fi
fi

on_chroot << 'EOF'
set -e
OUT=/usr/lib/vetura/secure-boot
SRC=/tmp/vetura-bootimg-src
mkdir -p "${OUT}"
rm -f "${OUT}/boot.img"
# Pi 4/5 ramdisk max is 180MB; a 256MB file is truncated and fails as Error 12.
truncate -s 128M "${OUT}/boot.img"
mkfs.vfat -F 32 -n RPIBOOT "${OUT}/boot.img"
mcopy -i "${OUT}/boot.img" -s "${SRC}"/* ::
rm -rf /tmp/vetura-bootimg-src
EOF

"${DIGEST}" -i "${OUT}/boot.img" -o "${OUT}/boot.sig" -k "${KEY}"
chmod 0644 "${OUT}/boot.img" "${OUT}/boot.sig"
# Fused devices load only this pair from FAT. Provision also copies it later,
# but a reflash never reaches Linux unless it is already on the boot partition.
install -m 0644 "${OUT}/boot.img" "${BOOT_SRC}/boot.img"
install -m 0644 "${OUT}/boot.sig" "${BOOT_SRC}/boot.sig"

if [[ "${LOCK_SIGNED_BOOT:-}" == "1" ]]; then
	on_chroot << 'EOF'
set -e
OUT=/usr/lib/vetura/secure-boot
pieeprom=""
for dir in \
	/usr/lib/firmware/raspberrypi/bootloader-2712/latest \
	/usr/lib/firmware/raspberrypi/bootloader-2712/default \
	/lib/firmware/raspberrypi/bootloader-2712/latest; do
	if [ -d "${dir}" ]; then
		pieeprom=$(ls "${dir}"/pieeprom*.bin 2>/dev/null | tail -1 || true)
		[ -n "${pieeprom}" ] && break
	fi
done
if [ -z "${pieeprom}" ] || ! command -v rpi-eeprom-config >/dev/null; then
	echo "LOCK_SIGNED_BOOT=1 but no 2712 pieeprom / rpi-eeprom-config in rootfs" >&2
	exit 1
fi
tmp=$(mktemp)
rpi-eeprom-config "${pieeprom}" > "${tmp}"
if grep -q '^SIGNED_BOOT=' "${tmp}"; then
	sed -i 's/^SIGNED_BOOT=.*/SIGNED_BOOT=1/' "${tmp}"
else
	printf '\nSIGNED_BOOT=1\n' >> "${tmp}"
fi
rpi-eeprom-config --config "${tmp}" --out "${OUT}/pieeprom.bin" "${pieeprom}"
rm -f "${tmp}"
EOF
	if [[ ! -f "${OUT}/pieeprom.bin" ]]; then
		echo "LOCK_SIGNED_BOOT=1 but pieeprom.bin was not created" >&2
		exit 1
	fi
	"${DIGEST}" -i "${OUT}/pieeprom.bin" -o "${OUT}/pieeprom.sig" -k "${KEY}"
	chmod 0644 "${OUT}/pieeprom.bin" "${OUT}/pieeprom.sig"
else
	# Staging: never lock the EEPROM. SIGNED_BOOT=1 without a pubkey in
	# EEPROM (rpiboot only on Pi 5) bricks the board (Error 12).
	rm -f "${OUT}/pieeprom.bin" "${OUT}/pieeprom.sig"
fi

rm -f "${ROOTFS_DIR}/.vetura-sb-key.pem" "${OUT}/"*.pem
