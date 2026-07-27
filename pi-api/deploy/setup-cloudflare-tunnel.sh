#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Tunnel: exposes the API without opening ports on your router.
# Prerequisites:
#   1. Domain managed in Cloudflare
#   2. cloudflared installed (this script installs it on Debian/Raspberry Pi OS)

TUNNEL_NAME="${1:-pi-api}"
HOSTNAME="${2:-pi.example.com}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 <tunnel-name> <hostname>"
  exit 1
fi

if [[ "${HOSTNAME}" == "pi.example.com" ]]; then
  echo "Usage: sudo $0 <tunnel-name> <hostname>"
  echo "Example: sudo $0 pi-api pi.mydomain.nl"
  exit 1
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  aarch64|arm64) CF_ARCH="arm64" ;;
  armv7l|armhf) CF_ARCH="arm" ;;
  x86_64) CF_ARCH="amd64" ;;
  *)
    echo "Unsupported architecture: ${ARCH}"
    exit 1
    ;;
esac

CF_VERSION="2025.2.1"
DEB="cloudflared-linux-${CF_ARCH}.deb"
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/${DEB}" -o "/tmp/${DEB}"
dpkg -i "/tmp/${DEB}"
rm -f "/tmp/${DEB}"

echo ""
echo "Next steps (interactive, run once):"
echo "  1. cloudflared tunnel login"
echo "  2. cloudflared tunnel create ${TUNNEL_NAME}"
echo "  3. cloudflared tunnel route dns ${TUNNEL_NAME} ${HOSTNAME}"
echo ""
echo "Then create /etc/cloudflared/config.yml with:"
cat <<EOF

tunnel: <TUNNEL_UUID>
credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: ${HOSTNAME}
    service: http://127.0.0.1:3000
  - service: http_status:404

EOF

echo "Enable the service:"
echo "  cloudflared service install"
echo "  systemctl enable --now cloudflared"
echo ""
echo "With Cloudflare Tunnel you do NOT need port 443 forwarded on your router."
echo "You can remove the ufw 443 rule if you are not using Caddy directly."
