#!/bin/bash -e
# Seed /opt/vetura-agent/.env with CLOUD_API_URL and CLOUD_FRONTEND_URL
# (and NATS placeholders from .env.example).

APP_DIR="${ROOTFS_DIR}/opt/vetura-agent"
ENV_FILE="${APP_DIR}/.env"
EXAMPLE="${APP_DIR}/.env.example"

if [[ -z "${CLOUD_API_URL:-}" ]]; then
  echo "CLOUD_API_URL is not set — export it in tools/image/config or config.local" >&2
  exit 1
fi

if [[ -z "${CLOUD_FRONTEND_URL:-}" ]]; then
  echo "CLOUD_FRONTEND_URL is not set — export it in tools/image/config or config.local" >&2
  exit 1
fi

if [[ -f "${EXAMPLE}" ]]; then
  cp "${EXAMPLE}" "${ENV_FILE}"
else
  touch "${ENV_FILE}"
fi

set_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

set_env_var "CLOUD_API_URL" "${CLOUD_API_URL}"
set_env_var "CLOUD_FRONTEND_URL" "${CLOUD_FRONTEND_URL}"

chmod 600 "${ENV_FILE}"
# Ownership fixed in 01-run-chroot of previous step may be lost after copy; fix here via numeric if needed.
# vetura-agent uid is assigned in chroot; defer chown to a small chroot script.
