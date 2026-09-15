#!/bin/bash -e
# Node.js 20 + npm from Raspberry Pi OS / Debian Trixie.
# The distro nodejs package does not include npm; do not use NodeSource
# (its repo is often unsigned/SHA-1-blocked on Trixie, so apt falls back
# to Debian nodejs and `npm` is missing).

apt-get install -y nodejs npm

command -v node >/dev/null
command -v npm >/dev/null
node --version
npm --version
