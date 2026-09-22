#!/bin/sh
# Install/update root helpers, sudoers, and systemd unit from the package tree.
# Runs as root via systemd ExecStartPre=+… before the portal starts.
set -eu

APP_DIR="/opt/vetura-agent"
HELPERS_SRC="${APP_DIR}/packaging/helpers"
SUDOERS_SRC="${APP_DIR}/packaging/sudoers-vetura-agent"
UNIT_SRC="${APP_DIR}/packaging/vetura-agent.service"
SBIN_DIR="/usr/local/sbin"
SUDOERS_DST="/etc/sudoers.d/vetura-agent"
UNIT_DST="/etc/systemd/system/vetura-agent.service"

if [ "$(id -u)" -ne 0 ]; then
    echo "sync-helpers.sh must run as root" >&2
    exit 1
fi

if [ ! -d "${HELPERS_SRC}" ]; then
    echo "Missing helpers directory: ${HELPERS_SRC}" >&2
    exit 1
fi

if [ ! -f "${SUDOERS_SRC}" ]; then
    echo "Missing sudoers file: ${SUDOERS_SRC}" >&2
    exit 1
fi

if [ ! -f "${UNIT_SRC}" ]; then
    echo "Missing unit file: ${UNIT_SRC}" >&2
    exit 1
fi

mkdir -p "${SBIN_DIR}"

# Only replace a file when its content changed, and then atomically (temp file,
# fsync, rename). A plain install rewrites in place without fsync; a power cut
# right after boot left /etc/systemd/system/vetura-agent.service empty, which
# systemd treats as masked, and the portal never came back.
# Returns 1 when the destination was left as is.
install_if_changed() {
    _src="$1"
    _dst="$2"
    _mode="$3"
    if cmp -s "${_src}" "${_dst}" 2>/dev/null; then
        return 1
    fi
    _tmp="${_dst}.tmp.$$"
    cp "${_src}" "${_tmp}"
    chown root:root "${_tmp}"
    chmod "${_mode}" "${_tmp}"
    sync "${_tmp}"
    mv -f "${_tmp}" "${_dst}"
    sync
    return 0
}

for helper in "${HELPERS_SRC}"/*; do
    [ -f "${helper}" ] || continue
    name=$(basename "${helper}")
    install_if_changed "${helper}" "${SBIN_DIR}/${name}" 0755 || true
done

if ! visudo -cf "${SUDOERS_SRC}" >/dev/null; then
    echo "Invalid sudoers content in ${SUDOERS_SRC}" >&2
    exit 1
fi
install_if_changed "${SUDOERS_SRC}" "${SUDOERS_DST}" 0440 || true

if install_if_changed "${UNIT_SRC}" "${UNIT_DST}" 0644; then
    systemctl daemon-reload
fi
