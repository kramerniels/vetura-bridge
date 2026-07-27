#!/usr/bin/env bash
set -euo pipefail

# SSH hardening for Raspberry Pi. Keeps SSH on LAN only — do NOT port-forward 22.

SSHD_CONFIG="/etc/ssh/sshd_config.d/99-pi-api-hardening.conf"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

cat > "${SSHD_CONFIG}" <<'EOF'
# Managed by pi-api deploy — SSH for admin access only
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
EOF

systemctl restart ssh || systemctl restart sshd

echo "SSH hardened: key-only auth, no root login."
echo "Ensure your SSH key works before closing this session."
echo "Do NOT forward port 22 on your router."
