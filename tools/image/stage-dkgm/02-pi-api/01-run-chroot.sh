#!/bin/bash -e
# Create service user, install deps, enable systemd unit (former deploy/install.sh).

APP_DIR="/opt/pi-api"
SERVICE_USER="pi-api"
SERVICE_GROUP="pi-api"

if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/pi-api
chmod 755 /var/lib/pi-api

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  cd "${APP_DIR}"
  sudo -u "${SERVICE_USER}" npm ci --omit=dev
fi

install -m 644 "${APP_DIR}/deploy/pi-api.service" /etc/systemd/system/pi-api.service
systemctl enable pi-api
