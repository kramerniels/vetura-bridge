#!/usr/bin/env bash
set -euo pipefail

# Create or update the JetStream stream and consumer on Scaleway NATS.
# Run once after deploying credentials and .env.

APP_DIR="${1:-/opt/pi-api}"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "Missing ${APP_DIR}/.env"
  exit 1
fi

cd "${APP_DIR}"
set -a
source "${APP_DIR}/.env"
set +a

npm run setup:jetstream
