#!/bin/bash -e
# Console lock, SSH drop-in already copied, initramfs + provision unit.

rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf

systemctl mask getty@tty1.service
systemctl mask getty@.service
systemctl mask serial-getty@.service
systemctl mask autovt@.service
systemctl mask debug-shell.service

systemctl enable dkgm-provision.service

for m in dm_mod dm_crypt xts aes_generic sha256; do
	grep -qxF "${m}" /etc/initramfs-tools/modules 2>/dev/null || echo "${m}" >> /etc/initramfs-tools/modules
done

# Ensure firmware crypto + cryptsetup are in every installed kernel's initramfs.
update-initramfs -u -k all
