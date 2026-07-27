#!/usr/bin/env bash
set -euo pipefail

# Install Caddy and deploy the reverse proxy config.
# Express continues to listen on 127.0.0.1:3000 only.

DOMAIN="${1:-pi.example.com}"
CADDYFILE_SRC="$(cd "$(dirname "$0")" && pwd)/Caddyfile"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 <domain>"
  exit 1
fi

if [[ "${DOMAIN}" == "pi.example.com" ]]; then
  echo "Usage: sudo $0 <your-domain>"
  exit 1
fi

apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl

curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

sed "s/pi.example.com/${DOMAIN}/g" "${CADDYFILE_SRC}" > /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo "Caddy configured for https://${DOMAIN}"
echo "Ensure DNS points to this host (or use Cloudflare Tunnel)."
