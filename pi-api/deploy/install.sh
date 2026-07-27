#!/usr/bin/env bash
set -euo pipefail

# Run on the Raspberry Pi as root to create the dedicated service user,
# install dependencies, and enable the systemd unit.

APP_DIR="/opt/pi-api"
SERVICE_USER="pi-api"
SERVICE_GROUP="pi-api"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  echo "Created user ${SERVICE_USER}"
fi

mkdir -p "${APP_DIR}"
cp -r . "${APP_DIR}/"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}/.env"
  echo "Created ${APP_DIR}/.env — set API_SECRET before starting the service."
fi

cd "${APP_DIR}"
sudo -u "${SERVICE_USER}" npm ci --omit=dev

cp "${APP_DIR}/deploy/pi-api.service" /etc/systemd/system/pi-api.service
systemctl daemon-reload
systemctl enable pi-api

echo "Installed pi-api. Edit ${APP_DIR}/.env, then run: systemctl start pi-api"
