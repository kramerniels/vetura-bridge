#!/bin/bash -e
# Copy the product package into the rootfs (prepared by tools/image/build.sh).

install -d -m 755 "${ROOTFS_DIR}/opt/pi-api"
install -d -m 755 "${ROOTFS_DIR}/var/lib/pi-api"

if [[ ! -f files/package.json ]]; then
  echo "Missing files/package.json — run tools/image/build.sh (it stages the package)." >&2
  exit 1
fi

cp -a files/. "${ROOTFS_DIR}/opt/pi-api/"
