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

for helper in "${HELPERS_SRC}"/*; do
    [ -f "${helper}" ] || continue
    name=$(basename "${helper}")
    install -o root -g root -m 0755 "${helper}" "${SBIN_DIR}/${name}"
done

sudoers_tmp=$(mktemp)
trap 'rm -f "${sudoers_tmp}"' EXIT
cp "${SUDOERS_SRC}" "${sudoers_tmp}"
chmod 0440 "${sudoers_tmp}"
if ! visudo -cf "${sudoers_tmp}" >/dev/null; then
    echo "Invalid sudoers content in ${SUDOERS_SRC}" >&2
    exit 1
fi
install -o root -g root -m 0440 "${sudoers_tmp}" "${SUDOERS_DST}"

install -o root -g root -m 0644 "${UNIT_SRC}" "${UNIT_DST}"
systemctl daemon-reload
