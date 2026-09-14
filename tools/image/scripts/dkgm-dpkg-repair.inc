# Sourced from stage preruns. Recovers dpkg after a killed Docker/pi-gen apt run.
# "dpkg was interrupted" is /var/lib/dpkg/updates; reinstreq needs --reinstall.

if [ -d "${ROOTFS_DIR}" ]; then
	on_chroot << 'CHROOT'
export DEBIAN_FRONTEND=noninteractive
dpkg --configure -a || true
pkgs=$(dpkg -l 2>/dev/null | awk 'NR>5 && $1 !~ /^(ii|rc|un|hi)/ {print $2}')
if [ -n "${pkgs}" ]; then
	# shellcheck disable=SC2086
	apt-get install --reinstall -y --no-install-recommends ${pkgs} || true
fi
apt-get -f install -y --no-install-recommends || true
dpkg --configure -a || true
CHROOT
	if [ -d "${PREV_ROOTFS_DIR:-}" ] && on_chroot << 'CHROOT'
dpkg --audit 2>/dev/null | grep -q 'must be reinstalled'
CHROOT
	then
		echo "Discarding dirty ${STAGE} rootfs (dpkg still broken); recopying previous stage"
		rm -rf "${ROOTFS_DIR}"
		copy_previous
	fi
fi
