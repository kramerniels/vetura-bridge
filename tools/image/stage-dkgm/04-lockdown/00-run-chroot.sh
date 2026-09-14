#!/bin/bash -e
# Console lock, SSH drop-in already copied, initramfs + provision unit.

rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf

systemctl mask getty@tty1.service
systemctl mask getty@.service
systemctl mask serial-getty@.service
systemctl mask autovt@.service
systemctl mask debug-shell.service

systemctl enable dkgm-provision.service
systemctl enable dkgm-console.service

systemctl disable NetworkManager-wait-online.service 2>/dev/null || true
systemctl mask NetworkManager-wait-online.service 2>/dev/null || true
systemctl disable cloud-init.service cloud-init-local.service cloud-config.service cloud-final.service 2>/dev/null || true

for m in dm_mod dm_crypt xts aes_generic aes_ce_cipher aes_ce_blk sha256 vcio; do
	grep -qxF "${m}" /etc/initramfs-tools/modules 2>/dev/null || echo "${m}" >> /etc/initramfs-tools/modules
done

# Disable v3d/vc4 in the live device tree (covers built-in drivers; blacklist is not enough).
if command -v dtc >/dev/null && [[ -f /usr/lib/dkgm/dkgm-disable-v3d.dts ]]; then
	install -d -m 0755 /boot/firmware/overlays
	dtc -@ -I dts -O dtb -o /boot/firmware/overlays/dkgm-disable-v3d.dtbo \
		/usr/lib/dkgm/dkgm-disable-v3d.dts
fi

# Ensure firmware crypto + cryptsetup are in every installed kernel's initramfs.
update-initramfs -u -k all
