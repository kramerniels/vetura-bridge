#!/bin/bash -e
# Seed /opt/pi-api/.env with CLOUD_BASE_URL (and NATS placeholders from .env.example).

APP_DIR="${ROOTFS_DIR}/opt/pi-api"
ENV_FILE="${APP_DIR}/.env"
EXAMPLE="${APP_DIR}/.env.example"

if [[ -z "${CLOUD_BASE_URL:-}" ]]; then
  echo "CLOUD_BASE_URL is not set — export it in tools/image/config or config.local" >&2
  exit 1
fi

if [[ -f "${EXAMPLE}" ]]; then
  cp "${EXAMPLE}" "${ENV_FILE}"
else
  touch "${ENV_FILE}"
fi

# Ensure CLOUD_BASE_URL matches build config (replace or append)
if grep -q '^CLOUD_BASE_URL=' "${ENV_FILE}"; then
  # Escape sed replacement carefully: use | delimiter
  sed -i "s|^CLOUD_BASE_URL=.*|CLOUD_BASE_URL=${CLOUD_BASE_URL}|" "${ENV_FILE}"
else
  printf '\nCLOUD_BASE_URL=%s\n' "${CLOUD_BASE_URL}" >> "${ENV_FILE}"
fi

chmod 600 "${ENV_FILE}"
# Ownership fixed in 01-run-chroot of previous step may be lost after copy; fix here via numeric if needed.
# pi-api uid is assigned in chroot; defer chown to a small chroot script.
