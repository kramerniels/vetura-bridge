#!/bin/bash -e
# Create service user, install deps, enable systemd unit.

APP_DIR="/opt/dkgm-agent"
SERVICE_USER="dkgm-agent"
SERVICE_GROUP="dkgm-agent"

if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/dkgm-agent
chmod 755 /var/lib/dkgm-agent

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  cd "${APP_DIR}"
  sudo -u "${SERVICE_USER}" npm ci --omit=dev
fi

install -m 644 "${APP_DIR}/packaging/dkgm-agent.service" /etc/systemd/system/dkgm-agent.service
systemctl enable dkgm-agent
