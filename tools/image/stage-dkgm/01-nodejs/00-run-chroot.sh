#!/bin/bash -e
# Install Node.js 20 (arm64) from NodeSource.

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

node --version
npm --version
