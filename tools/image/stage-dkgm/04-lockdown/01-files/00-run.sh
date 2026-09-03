#!/bin/bash -e
# Install lockdown files into the rootfs (not chroot).

install -d -m 0755 "${ROOTFS_DIR}/usr/lib/dkgm"
install -d -m 0755 "${ROOTFS_DIR}/etc/ssh/sshd_config.d"
install -d -m 0755 "${ROOTFS_DIR}/etc/systemd/logind.conf.d"
install -d -m 0755 "${ROOTFS_DIR}/etc/initramfs-tools/hooks"
install -d -m 0755 "${ROOTFS_DIR}/etc/initramfs-tools/scripts/local-premount"

install -m 0644 files/sshd-dkgm.conf "${ROOTFS_DIR}/etc/ssh/sshd_config.d/dkgm.conf"
install -m 0644 files/disable-vts.conf "${ROOTFS_DIR}/etc/systemd/logind.conf.d/disable-vts.conf"
install -m 0755 files/luks-key "${ROOTFS_DIR}/usr/lib/dkgm/luks-key"
install -m 0755 files/dkgm-provision "${ROOTFS_DIR}/usr/lib/dkgm/dkgm-provision"
install -m 0644 files/dkgm-provision.service "${ROOTFS_DIR}/etc/systemd/system/dkgm-provision.service"
install -m 0755 files/initramfs-hook "${ROOTFS_DIR}/etc/initramfs-tools/hooks/dkgm-crypt"
install -m 0755 files/initramfs-crypt "${ROOTFS_DIR}/etc/initramfs-tools/scripts/local-premount/dkgm-crypt"
