#!/usr/bin/env bash
# Build the DKGM Raspberry Pi OS golden image via pi-gen (Docker).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PIGEN_DIR="${SCRIPT_DIR}/.pi-gen"
PIGEN_REPO="${PIGEN_REPO:-https://github.com/RPi-Distro/pi-gen.git}"
PIGEN_BRANCH="${PIGEN_BRANCH:-arm64}"
STAGE_SRC="${SCRIPT_DIR}/stage-dkgm"
STAGE_DST="${PIGEN_DIR}/stage-dkgm"
PACKAGE_FILES="${STAGE_SRC}/02-dkgm-agent/files"
OUT_DIR="${SCRIPT_DIR}/deploy"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the image." >&2
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/package.json" ]]; then
  echo "Expected package.json at repo root: ${REPO_ROOT}" >&2
  exit 1
fi

if [[ ! -f "${SCRIPT_DIR}/config.local" ]]; then
  echo "Missing ${SCRIPT_DIR}/config.local" >&2
  echo "Copy config.local.example → config.local and set CLOUD_API_URL, CLOUD_FRONTEND_URL, PUBKEY_SSH_FIRST_USER, SECURE_BOOT_KEY." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
# Shared defaults then secrets. config.local is gitignored.
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/config"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/config.local"
set +a

if ! grep -qE '^(export[[:space:]]+)?CLOUD_API_URL=' "${SCRIPT_DIR}/config.local"; then
  echo "CLOUD_API_URL is required in config.local (CLOUD_BASE_URL was renamed)." >&2
  exit 1
fi
if ! grep -qE '^(export[[:space:]]+)?CLOUD_FRONTEND_URL=' "${SCRIPT_DIR}/config.local"; then
  echo "CLOUD_FRONTEND_URL is required in config.local (QR / pair URL base)." >&2
  exit 1
fi
if [[ -z "${CLOUD_API_URL:-}" ]]; then
  echo "CLOUD_API_URL is empty — set it in config.local." >&2
  exit 1
fi
if [[ -z "${CLOUD_FRONTEND_URL:-}" ]]; then
  echo "CLOUD_FRONTEND_URL is empty — set it in config.local." >&2
  exit 1
fi

if [[ -z "${PUBKEY_SSH_FIRST_USER:-}" ]]; then
  echo "PUBKEY_SSH_FIRST_USER is required in config.local (support SSH public key)." >&2
  exit 1
fi
if [[ "${PUBKEY_ONLY_SSH:-}" != "1" ]]; then
  echo "PUBKEY_ONLY_SSH=1 is required in config.local." >&2
  exit 1
fi
if [[ -z "${SECURE_BOOT_KEY:-}" || ! -f "${SECURE_BOOT_KEY}" ]]; then
  echo "SECURE_BOOT_KEY must be a readable RSA 2048 PEM (openssl genrsa 2048 > secure-boot.pem)." >&2
  exit 1
fi

if [[ -z "${FIRST_USER_PASS:-}" || "${FIRST_USER_PASS}" == "change-me" ]]; then
  FIRST_USER_PASS="$(openssl rand -base64 33)"
  echo "==> Generated random FIRST_USER_PASS (not used for SSH login)"
fi

echo "==> Preparing product package for the image stage"
rm -rf "${PACKAGE_FILES}"
mkdir -p "${PACKAGE_FILES}"
printf '%s\n' '# Populated by build.sh — do not commit package contents.' > "${PACKAGE_FILES}/.gitkeep"
for path in package.json package-lock.json src packaging; do
  if [[ -e "${REPO_ROOT}/${path}" ]]; then
    cp -a "${REPO_ROOT}/${path}" "${PACKAGE_FILES}/${path}"
  fi
done
# Seed .env from this example inside the image stage (not part of OTA zip)
if [[ -f "${REPO_ROOT}/.env.example" ]]; then
  cp "${REPO_ROOT}/.env.example" "${PACKAGE_FILES}/.env.example"
fi
# Never bake host secrets or tools/
rm -f "${PACKAGE_FILES}/.env" "${PACKAGE_FILES}/credentials.creds"
rm -rf "${PACKAGE_FILES}/node_modules"

echo "==> Fetching pi-gen (${PIGEN_BRANCH})"
if [[ ! -d "${PIGEN_DIR}/.git" ]]; then
  git clone --branch "${PIGEN_BRANCH}" --depth 1 "${PIGEN_REPO}" "${PIGEN_DIR}"
else
  git -C "${PIGEN_DIR}" fetch --depth 1 origin "${PIGEN_BRANCH}"
  git -C "${PIGEN_DIR}" checkout "${PIGEN_BRANCH}"
  git -C "${PIGEN_DIR}" reset --hard "origin/${PIGEN_BRANCH}"
fi

echo "==> Installing stage-dkgm into pi-gen worktree"
rm -rf "${STAGE_DST}"
cp -a "${STAGE_SRC}" "${STAGE_DST}"
# Ensure stage scripts are executable
find "${STAGE_DST}" -type f \( -name 'prerun.sh' -o -name '*-run.sh' -o -name '*-run-chroot.sh' \) -exec chmod +x {} +

# CONTINUE reuses a work volume whose apt lists / dpkg may be truncated.
cp "${SCRIPT_DIR}/scripts/dkgm-dpkg-repair.inc" "${PIGEN_DIR}/scripts/dkgm-dpkg-repair.inc"
dkgm_append_dpkg_repair() {
  local prerun="$1"
  [[ -f "${prerun}" ]] || return 0
  grep -q 'dkgm-dpkg-repair' "${prerun}" && return 0
  cat >> "${prerun}" << 'EOF'

# dkgm-dpkg-repair
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/dkgm-dpkg-repair.inc"
EOF
}
dkgm_append_dpkg_repair "${PIGEN_DIR}/stage0/prerun.sh"
dkgm_append_dpkg_repair "${PIGEN_DIR}/stage1/prerun.sh"
dkgm_append_dpkg_repair "${PIGEN_DIR}/stage2/prerun.sh"

# Lite image only: skip desktop stages; export after stage-dkgm (not stage2)
touch "${PIGEN_DIR}/stage3/SKIP" "${PIGEN_DIR}/stage4/SKIP" "${PIGEN_DIR}/stage5/SKIP"
touch "${PIGEN_DIR}/stage2/SKIP_IMAGES"
# stage4/5 also have EXPORT_*; keep SKIP_IMAGES for safety if STAGE_LIST is overridden
touch "${PIGEN_DIR}/stage4/SKIP_IMAGES" "${PIGEN_DIR}/stage5/SKIP_IMAGES"

echo "==> Merging config + config.local into pi-gen"
# Write into the pi-gen tree (not a path outside it). build-docker.sh on macOS does
# not rewrite -c <hostpath> to /config inside the container (BSD sed has no \s),
# so ./build.sh would source a Mac path that does not exist in Docker.
# Trailing assignments override FIRST_USER_PASS if it was randomised above.
{
  cat "${SCRIPT_DIR}/config"
  echo
  cat "${SCRIPT_DIR}/config.local"
  echo
  echo "PUBKEY_ONLY_SSH=1"
  printf "FIRST_USER_PASS=%q\n" "${FIRST_USER_PASS}"
} > "${PIGEN_DIR}/config"

# Signing key and digest tool for stage-dkgm/05-secure-boot (never copied into rootfs).
cp "${SECURE_BOOT_KEY}" "${PIGEN_DIR}/.dkgm-sb-key.pem"
chmod 600 "${PIGEN_DIR}/.dkgm-sb-key.pem"
cp "${SCRIPT_DIR}/scripts/rpi-eeprom-digest" "${PIGEN_DIR}/dkgm-rpi-eeprom-digest"
chmod 755 "${PIGEN_DIR}/dkgm-rpi-eeprom-digest"

# Reuse one pi-gen builder image. COPY . /pi-gen/ changed every run, left
# dangling ~889MB images, and baked the signing PEM into Docker layers.
dkgm_patch_pigen_docker() {
  local df="${PIGEN_DIR}/Dockerfile"
  local bd="${PIGEN_DIR}/build-docker.sh"
  awk '
    /COPY \. \/pi-gen\// { next }
    /arch-test \\$/ { sub(/arch-test \\/, "arch-test openssl \\") }
    { print }
  ' "${df}" > "${df}.dkgm"
  mv "${df}.dkgm" "${df}"
  if ! grep -q '${DIR}:/pi-gen' "${bd}"; then
    python3 - "${bd}" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = '  --volume "${CONFIG_FILE}":/config:ro \\\n'
new = '  --volume "${DIR}:/pi-gen" \\\n  --volume "${CONFIG_FILE}":/config:ro \\\n'
if old not in text:
    sys.exit("build-docker.sh: expected config volume line not found")
path.write_text(text.replace(old, new, 1))
PY
  fi
}
dkgm_patch_pigen_docker

# Keep only the newest flash artifact (dated image_*.img.xz pile up otherwise).
# KEEP_OLD_IMAGES=1 skips this.
dkgm_prune_old_flash_images() {
  local dir="$1"
  [[ "${KEEP_OLD_IMAGES:-}" == "1" ]] && return 0
  [[ -d "${dir}" ]] || return 0
  local newest stem datepart
  newest="$(ls -t "${dir}"/image_*.img.xz 2>/dev/null | head -1 || true)"
  [[ -n "${newest}" ]] || return 0
  stem="$(basename "${newest}" .img.xz)"
  datepart="${stem#image_}"
  find "${dir}" -maxdepth 1 -type f \( -name 'image_*.img.xz' -o -name 'image_*.img' \) \
    ! -name "$(basename "${newest}")" -print -delete
  find "${dir}" -maxdepth 1 -type f -name '*-dkgm-pi-lite.info' \
    ! -name "${datepart}.info" -print -delete
}

mkdir -p "${OUT_DIR}"
echo "==> Removing older flash images (KEEP_OLD_IMAGES=1 to keep them)"
dkgm_prune_old_flash_images "${PIGEN_DIR}/deploy"
dkgm_prune_old_flash_images "${OUT_DIR}"
if docker image prune -f >/dev/null; then
  echo "==> Removed dangling Docker images"
fi

# build-docker.sh exits before `docker rm` when the build fails, which would
# otherwise abort the next run. Resume that work volume (stage0–2 stay cached).
# Full clean rebuild: CLEAN=1 ./build.sh
if [[ "${CLEAN:-}" == "1" ]]; then
  echo "==> CLEAN=1: removing leftover pigen_work"
  docker rm -f -v pigen_work 2>/dev/null || true
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx pigen_work; then
  echo "==> Resuming leftover pigen_work container (CONTINUE=1)"
  export CONTINUE=1
fi

echo "==> Building image (pi-gen build-docker.sh) — this can take a long time"
(
  cd "${PIGEN_DIR}"
  ./build-docker.sh
)

echo "==> Collecting artifacts into ${OUT_DIR}"
# build-docker.sh extracts deploy/ next to pi-gen; copy into tools/image/deploy
if [[ -d "${PIGEN_DIR}/deploy" ]]; then
  dkgm_prune_old_flash_images "${PIGEN_DIR}/deploy"
  rm -rf "${OUT_DIR}"
  mkdir -p "${OUT_DIR}"
  cp -a "${PIGEN_DIR}/deploy/." "${OUT_DIR}/"
  dkgm_prune_old_flash_images "${OUT_DIR}"
fi

echo "Done. Flash an image from ${OUT_DIR}/ (see README.md)."
