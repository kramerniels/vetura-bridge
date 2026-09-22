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
# Firmware only trusts this config.txt once signed boot is enforced. Blocks the
# raw OTP key read; hmac (LUKS passphrase) keeps working. program_pubkey does
# not belong here: the fuse is set from the recovery config.txt
# (provision-secure-boot.sh).
if ! grep -q '^lock_device_private_key=' "${cfg}"; then
	printf '\nlock_device_private_key=1\n' >>"${cfg}"
fi

# boot.img is only used once signed boot is enforced, which is after the
# first-boot LUKS encrypt. pi-gen still has root=ROOTDEV and resize here (the
# PARTUUID is filled in later, and only in the loose cmdline.txt).
cmdline="${ROOTFS_DIR}/tmp/vetura-bootimg-src/cmdline.txt"
if [[ ! -f "${cmdline}" ]]; then
	echo "Missing cmdline.txt in ${BOOT_SRC}" >&2
	exit 1
fi
sed -i -E 's/[[:space:]]+resize([[:space:]]|$)/\1/; s|root=[^[:space:]]+|root=/dev/mapper/cryptroot|' "${cmdline}"
if ! grep -q 'root=/dev/mapper/cryptroot' "${cmdline}"; then
	echo "Could not point boot.img cmdline.txt at the LUKS mapper" >&2
	exit 1
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

# No pieeprom in the image: the EEPROM is provisioned per device, out of band.
rm -f "${OUT}/pieeprom.bin" "${OUT}/pieeprom.sig"

rm -f "${ROOTFS_DIR}/.vetura-sb-key.pem" "${OUT}/"*.pem
