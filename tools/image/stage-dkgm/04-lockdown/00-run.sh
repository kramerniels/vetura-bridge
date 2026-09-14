#!/bin/bash -e
# Install lockdown files into the rootfs (not chroot).

install -d -m 0755 "${ROOTFS_DIR}/usr/lib/dkgm"
install -d -m 0755 "${ROOTFS_DIR}/etc/ssh/sshd_config.d"
install -d -m 0755 "${ROOTFS_DIR}/etc/systemd/logind.conf.d"
install -d -m 0755 "${ROOTFS_DIR}/etc/initramfs-tools/hooks"
install -d -m 0755 "${ROOTFS_DIR}/etc/initramfs-tools/scripts/local-premount"
install -d -m 0755 "${ROOTFS_DIR}/etc/modprobe.d"
install -d -m 0755 "${ROOTFS_DIR}/boot/firmware/overlays"

install -m 0644 files/sshd-dkgm.conf "${ROOTFS_DIR}/etc/ssh/sshd_config.d/dkgm.conf"
install -m 0644 files/disable-vts.conf "${ROOTFS_DIR}/etc/systemd/logind.conf.d/disable-vts.conf"
install -m 0644 files/dkgm-no-kms.conf "${ROOTFS_DIR}/etc/modprobe.d/dkgm-no-kms.conf"
install -m 0644 files/dkgm-disable-v3d.dts "${ROOTFS_DIR}/usr/lib/dkgm/dkgm-disable-v3d.dts"
install -m 0755 files/luks-key "${ROOTFS_DIR}/usr/lib/dkgm/luks-key"
install -m 0755 files/dkgm-provision "${ROOTFS_DIR}/usr/lib/dkgm/dkgm-provision"
install -m 0644 files/dkgm-provision.service "${ROOTFS_DIR}/etc/systemd/system/dkgm-provision.service"
install -m 0755 files/initramfs-hook "${ROOTFS_DIR}/etc/initramfs-tools/hooks/dkgm-crypt"
install -m 0755 files/initramfs-crypt "${ROOTFS_DIR}/etc/initramfs-tools/scripts/local-premount/dkgm-crypt"
install -m 0755 files/console-status "${ROOTFS_DIR}/usr/lib/dkgm/console-status"
install -m 0644 files/dkgm-console.service "${ROOTFS_DIR}/etc/systemd/system/dkgm-console.service"
install -d -m 0755 "${ROOTFS_DIR}/etc/NetworkManager/system-connections"
install -m 0600 files/nm-ethernet.nmconnection "${ROOTFS_DIR}/etc/NetworkManager/system-connections/dkgm-wired.nmconnection"
install -d -m 0755 "${ROOTFS_DIR}/etc/cloud"
# Disable cloud-init even if the package stays on the image.
touch "${ROOTFS_DIR}/etc/cloud/cloud-init.disabled"

# Firmware framebuffer for every boot (encrypt, LUKS open, provision, signed boot).
# KMS/v3d takes HDMI; the last line is bcm2835-pm sync_state() pending due to v3d.
append_cmdline_token() {
	local file="$1"
	local token="$2"
	[[ -f "${file}" ]] || return 0
	if grep -qE "(^|[[:space:]])${token}([[:space:]]|$)" "${file}"; then
		return 0
	fi
	sed -i -E "s/[[:space:]]*$/ ${token}/" "${file}"
}

for cmd in "${ROOTFS_DIR}/boot/firmware/cmdline.txt" "${ROOTFS_DIR}/boot/cmdline.txt"; do
	if [[ -f "${cmd}" ]]; then
		sed -i -E 's/[[:space:]]+(quiet|splash)([[:space:]]|$)/ /g' "${cmd}"
		append_cmdline_token "${cmd}" 'nomodeset'
		append_cmdline_token "${cmd}" 'modprobe.blacklist=v3d,vc4'
	fi
done

fw="${ROOTFS_DIR}/boot/firmware"
if [[ -d "${fw}" ]]; then
	shopt -s nullglob
	for cfg in "${fw}"/*.txt; do
		sed -i -E 's/^[[:space:]]*(dtoverlay=vc4-kms-v3d.*)/# dkgm: \1/' "${cfg}"
		sed -i -E 's/^[[:space:]]*(dtoverlay=vc4-fkms-v3d.*)/# dkgm: \1/' "${cfg}"
	done
	if [[ -f "${fw}/config.txt" ]] && ! grep -q 'dtoverlay=dkgm-disable-v3d' "${fw}/config.txt"; then
		printf '\n[all]\n# Appliance: disable v3d/vc4 so HDMI stays on the firmware FB.\ndtoverlay=dkgm-disable-v3d\n' >> "${fw}/config.txt"
	fi
fi
