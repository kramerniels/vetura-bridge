#!/usr/bin/env bash
set -euo pipefail

# Run on the Raspberry Pi as root to create the dedicated service user,
# install dependencies, and enable the systemd unit.
#
# Copies only the product package (same set as the OTA release zip).
# Does not copy tools/, docs, or other repo-only paths.

APP_DIR="/opt/pi-api"
SERVICE_USER="pi-api"
SERVICE_GROUP="pi-api"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ ! -f "${PACKAGE_ROOT}/package.json" ]]; then
  echo "Missing package.json in ${PACKAGE_ROOT}" >&2
  exit 1
fi

if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  echo "Created user ${SERVICE_USER}"
fi

mkdir -p "${APP_DIR}"

# Same paths as the release zip in commands.md — never copy tools/ or .git
for path in package.json package-lock.json src deploy; do
  if [[ -e "${PACKAGE_ROOT}/${path}" ]]; then
    rm -rf "${APP_DIR}/${path}"
    cp -a "${PACKAGE_ROOT}/${path}" "${APP_DIR}/${path}"
  fi
done

if [[ -d "${PACKAGE_ROOT}/node_modules" ]]; then
  rm -rf "${APP_DIR}/node_modules"
  cp -a "${PACKAGE_ROOT}/node_modules" "${APP_DIR}/node_modules"
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  if [[ -f "${PACKAGE_ROOT}/.env.example" ]]; then
    cp "${PACKAGE_ROOT}/.env.example" "${APP_DIR}/.env"
  else
    touch "${APP_DIR}/.env"
  fi
  chmod 600 "${APP_DIR}/.env"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}/.env"
  echo "Created ${APP_DIR}/.env — set CLOUD_BASE_URL (and NATS fields if needed) before starting."
fi

if [[ -f "${APP_DIR}/credentials.creds" ]]; then
  chmod 600 "${APP_DIR}/credentials.creds"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}/credentials.creds"
fi

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  cd "${APP_DIR}"
  sudo -u "${SERVICE_USER}" npm ci --omit=dev
fi

cp "${APP_DIR}/deploy/pi-api.service" /etc/systemd/system/pi-api.service
systemctl daemon-reload
systemctl enable pi-api

echo "Installed pi-api. Edit ${APP_DIR}/.env, then: systemctl start pi-api"
# Helpers/sudoers sync on first start via ExecStartPre=sync-helpers.sh
