#!/bin/bash -e

if [ ! -d "${ROOTFS_DIR}" ]; then
	copy_previous
fi

# shellcheck disable=SC1091
. "${SCRIPT_DIR}/vetura-dpkg-repair.inc"
