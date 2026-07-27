#!/usr/bin/env bash
set -euo pipefail

# Harden the Pi firewall. SSH stays LAN-only; only HTTPS is exposed publicly
# when using port forwarding. Prefer Cloudflare Tunnel instead.

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

apt-get update
apt-get install -y ufw

ufw default deny incoming
ufw default allow outgoing

# SSH: only from local network (adjust subnet to match your LAN)
ufw allow from 192.168.0.0/16 to any port 22 proto tcp comment "SSH LAN only"

# HTTPS for Caddy (skip if using Cloudflare Tunnel with no port forwarding)
ufw allow 443/tcp comment "HTTPS via Caddy"

ufw --force enable
ufw status verbose

echo ""
echo "Firewall enabled. Verify SSH is NOT forwarded on your router."
echo "For remote access, use Cloudflare Tunnel (see deploy/setup-cloudflare-tunnel.sh)."
