#!/bin/bash -e
# Create service user, install deps, enable systemd unit.

APP_DIR="/opt/vetura-agent"
SERVICE_USER="vetura-agent"
SERVICE_GROUP="vetura-agent"

if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/vetura-agent
chmod 755 /var/lib/vetura-agent

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  cd "${APP_DIR}"
  sudo -u "${SERVICE_USER}" npm ci --omit=dev
fi

install -m 644 "${APP_DIR}/packaging/vetura-agent.service" /etc/systemd/system/vetura-agent.service
systemctl enable vetura-agent
