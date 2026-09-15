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

# Browser kiosk user: not the SSH account (that one has passwordless sudo).
if ! id dkgm-hdmi >/dev/null 2>&1; then
	useradd --system --home /var/lib/dkgm-hdmi --create-home \
		--shell /usr/sbin/nologin --comment "DKGM HDMI kiosk" dkgm-hdmi
fi
for g in video tty render input; do
	if getent group "${g}" >/dev/null; then
		usermod -aG "${g}" dkgm-hdmi || true
	fi
done
install -d -m 0755 /var/lib/dkgm-hdmi
chown -R dkgm-hdmi:dkgm-hdmi /var/lib/dkgm-hdmi

# Keep the splash until the kiosk takes the framebuffer.
systemctl mask plymouth-quit.service plymouth-quit-wait.service 2>/dev/null || true
systemctl enable plymouth-start.service 2>/dev/null || true

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

if command -v plymouth-set-default-theme >/dev/null 2>&1; then
	plymouth-set-default-theme dkgm
fi

# Ensure firmware crypto + cryptsetup are in every installed kernel's initramfs.
update-initramfs -u -k all
