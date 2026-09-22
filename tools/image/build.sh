#!/usr/bin/env bash
# Build the Vetura Raspberry Pi OS golden image via pi-gen (Docker).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PIGEN_DIR="${SCRIPT_DIR}/.pi-gen"
PIGEN_REPO="${PIGEN_REPO:-https://github.com/RPi-Distro/pi-gen.git}"
PIGEN_BRANCH="${PIGEN_BRANCH:-arm64}"
STAGE_SRC="${SCRIPT_DIR}/stage-vetura"
STAGE_DST="${PIGEN_DIR}/stage-vetura"
PACKAGE_FILES="${STAGE_SRC}/02-vetura-agent/files"
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
  echo "Copy config.local.example → config.local and set IMAGE_ENV, staging/production CLOUD_* URLs, PUBKEY_SSH_FIRST_USER, SECURE_BOOT_KEY." >&2
  exit 1
fi

# CLI IMAGE_ENV=production ./build.sh must win over config.local.
CLI_IMAGE_ENV="${IMAGE_ENV:-}"

# shellcheck disable=SC1091
set -a
# Shared defaults then secrets. config.local is gitignored.
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/config"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/config.local"
set +a

if [[ -n "${CLI_IMAGE_ENV}" ]]; then
  IMAGE_ENV="${CLI_IMAGE_ENV}"
fi
IMAGE_ENV="$(printf '%s' "${IMAGE_ENV:-staging}" | tr '[:upper:]' '[:lower:]')"
case "${IMAGE_ENV}" in
  staging|production) ;;
  *)
    echo "IMAGE_ENV must be staging or production (got: ${IMAGE_ENV})." >&2
    exit 1
    ;;
esac

if [[ "${IMAGE_ENV}" == "production" ]]; then
  CLOUD_API_URL="${PRODUCTION_CLOUD_API_URL:-}"
  CLOUD_FRONTEND_URL="${PRODUCTION_CLOUD_FRONTEND_URL:-}"
  if [[ -z "${CLOUD_API_URL}" || -z "${CLOUD_FRONTEND_URL}" ]]; then
    echo "Production requires PRODUCTION_CLOUD_API_URL and PRODUCTION_CLOUD_FRONTEND_URL in config.local." >&2
    exit 1
  fi
else
  CLOUD_API_URL="${STAGING_CLOUD_API_URL:-${CLOUD_API_URL:-}}"
  CLOUD_FRONTEND_URL="${STAGING_CLOUD_FRONTEND_URL:-${CLOUD_FRONTEND_URL:-}}"
fi

if [[ -z "${CLOUD_API_URL:-}" ]]; then
  echo "CLOUD_API_URL is empty — set STAGING_CLOUD_API_URL (or CLOUD_API_URL) in config.local." >&2
  exit 1
fi
if [[ -z "${CLOUD_FRONTEND_URL:-}" ]]; then
  echo "CLOUD_FRONTEND_URL is empty — set STAGING_CLOUD_FRONTEND_URL (or CLOUD_FRONTEND_URL) in config.local." >&2
  exit 1
fi

echo "==> IMAGE_ENV=${IMAGE_ENV}"
echo "    CLOUD_API_URL=${CLOUD_API_URL}"
echo "    CLOUD_FRONTEND_URL=${CLOUD_FRONTEND_URL}"
echo "    The image never writes the EEPROM; lock a device with provision-secure-boot.sh."

if [[ -z "${PUBKEY_SSH_FIRST_USER:-}" ]]; then
  echo "PUBKEY_SSH_FIRST_USER is required in config.local (support SSH public key)." >&2
  exit 1
fi
if [[ "${PUBKEY_ONLY_SSH:-}" != "1" ]]; then
  echo "PUBKEY_ONLY_SSH=1 is required in config.local." >&2
  exit 1
fi
if [[ -z "${SECURE_BOOT_KEY:-}" || ! -f "${SECURE_BOOT_KEY}" ]]; then
  echo "SECURE_BOOT_KEY must be a readable RSA 2048 PEM (the ${IMAGE_ENV} signing key)." >&2
  exit 1
fi

# A Pi only boots images signed with the key it was provisioned with, so never
# sign an image with the other environment's key.
SECURE_BOOT_PUBKEY="${SCRIPT_DIR}/keys/${IMAGE_ENV}.pub.pem"
signing_pubkey="$(openssl pkey -in "${SECURE_BOOT_KEY}" -pubout)"
expected_pubkey="$(openssl pkey -pubin -in "${SECURE_BOOT_PUBKEY}" -pubout)"
if [[ "${signing_pubkey}" != "${expected_pubkey}" ]]; then
  echo "SECURE_BOOT_KEY is not the ${IMAGE_ENV} signing key (${SECURE_BOOT_PUBKEY})." >&2
  exit 1
fi

if [[ -z "${FIRST_USER_PASS:-}" || "${FIRST_USER_PASS}" == "change-me" ]]; then
  FIRST_USER_PASS="$(openssl rand -base64 33)"
  echo "==> Generated random FIRST_USER_PASS (not used for SSH login)"
fi

# <name>-<env>-<short sha>; -dirty when tracked files have uncommitted changes.
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short=7 HEAD)"
if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain --untracked-files=no)" ]]; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
IMG_NAME="${IMG_NAME}-${IMAGE_ENV}-${GIT_SHA}"
echo "==> Building ${IMG_NAME}"

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

echo "==> Installing stage-vetura into pi-gen worktree"
rm -rf "${STAGE_DST}"
cp -a "${STAGE_SRC}" "${STAGE_DST}"
# Ensure stage scripts are executable
find "${STAGE_DST}" -type f \( -name 'prerun.sh' -o -name '*-run.sh' -o -name '*-run-chroot.sh' \) -exec chmod +x {} +

# CONTINUE reuses a work volume whose apt lists / dpkg may be truncated.
cp "${SCRIPT_DIR}/scripts/vetura-dpkg-repair.inc" "${PIGEN_DIR}/scripts/vetura-dpkg-repair.inc"
vetura_append_dpkg_repair() {
  local prerun="$1"
  [[ -f "${prerun}" ]] || return 0
  grep -q 'vetura-dpkg-repair' "${prerun}" && return 0
  cat >> "${prerun}" << 'EOF'

# vetura-dpkg-repair
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/vetura-dpkg-repair.inc"
EOF
}
vetura_append_dpkg_repair "${PIGEN_DIR}/stage0/prerun.sh"
vetura_append_dpkg_repair "${PIGEN_DIR}/stage1/prerun.sh"
vetura_append_dpkg_repair "${PIGEN_DIR}/stage2/prerun.sh"

# Lite image only: skip desktop stages; export after stage-vetura (not stage2)
touch "${PIGEN_DIR}/stage3/SKIP" "${PIGEN_DIR}/stage4/SKIP" "${PIGEN_DIR}/stage5/SKIP"
touch "${PIGEN_DIR}/stage2/SKIP_IMAGES"
# stage4/5 also have EXPORT_*; keep SKIP_IMAGES for safety if STAGE_LIST is overridden
touch "${PIGEN_DIR}/stage4/SKIP_IMAGES" "${PIGEN_DIR}/stage5/SKIP_IMAGES"

echo "==> Merging config + config.local into pi-gen"
# Write into the pi-gen tree (not a path outside it). build-docker.sh on macOS does
# not rewrite -c <hostpath> to /config inside the container (BSD sed has no \s),
# so ./build.sh would source a Mac path that does not exist in Docker.
# Trailing assignments override FIRST_USER_PASS if it was randomised above, and
# name the output <IMG_NAME>.img.xz instead of pi-gen's image_<date>-<IMG_NAME>.img.xz.
{
  cat "${SCRIPT_DIR}/config"
  echo
  cat "${SCRIPT_DIR}/config.local"
  echo
  echo "PUBKEY_ONLY_SSH=1"
  printf "FIRST_USER_PASS=%q\n" "${FIRST_USER_PASS}"
  printf "export IMAGE_ENV=%q\n" "${IMAGE_ENV}"
  printf "export CLOUD_API_URL=%q\n" "${CLOUD_API_URL}"
  printf "export CLOUD_FRONTEND_URL=%q\n" "${CLOUD_FRONTEND_URL}"
  printf "IMG_NAME=%q\nIMG_FILENAME=%q\nARCHIVE_FILENAME=%q\n" "${IMG_NAME}" "${IMG_NAME}" "${IMG_NAME}"
} > "${PIGEN_DIR}/config"

# Signing key and digest tool for stage-vetura/05-secure-boot (never copied into rootfs).
cp "${SECURE_BOOT_KEY}" "${PIGEN_DIR}/.vetura-sb-key.pem"
chmod 600 "${PIGEN_DIR}/.vetura-sb-key.pem"
cp "${SCRIPT_DIR}/scripts/rpi-eeprom-digest" "${PIGEN_DIR}/vetura-rpi-eeprom-digest"
chmod 755 "${PIGEN_DIR}/vetura-rpi-eeprom-digest"

# Reuse one pi-gen builder image. COPY . /pi-gen/ changed every run, left
# dangling ~889MB images, and baked the signing PEM into Docker layers.
vetura_patch_pigen_docker() {
  local df="${PIGEN_DIR}/Dockerfile"
  local bd="${PIGEN_DIR}/build-docker.sh"
  awk '
    /COPY \. \/pi-gen\// { next }
    /arch-test \\$/ { sub(/arch-test \\/, "arch-test openssl \\") }
    { print }
  ' "${df}" > "${df}.vetura"
  mv "${df}.vetura" "${df}"
  if ! grep -q '${DIR}:/pi-gen' "${bd}"; then
    python3 - "${bd}" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = '  --volume "${CONFIG_FILE}":/config:ro \\\n'
new = '  --volume "${DIR}:/pi-gen" \\\n  --volume "${CONFIG_FILE}":/config:ro \\\n'
if old not in text:
    sys.exit("build-docker.sh: expected config volume line not found")
text = text.replace(old, new, 1)
# The image declares VOLUME /pi-gen/deploy, so the results live in an anonymous
# volume and docker cp is still needed. Docker creates the host mountpoint
# deploy/ as root, which makes that tar fail for a non-root user (Linux CI).
old_cp = '${DOCKER} cp "${CONTAINER_NAME}":/pi-gen/deploy - | tar -xf -\n'
chown = 'mkdir -p "${DIR}/deploy"\n${DOCKER} run --rm --volume "${DIR}/deploy:/mnt/deploy" pi-gen chown -R "$(id -u):$(id -g)" /mnt/deploy\n'
if old_cp not in text:
    sys.exit("build-docker.sh: expected deploy copy line not found")
path.write_text(text.replace(old_cp, chown + old_cp, 1))
PY
  fi
}
vetura_patch_pigen_docker

# Keep only the newest flash artifact (one .img.xz per commit piles up otherwise).
# KEEP_OLD_IMAGES=1 skips this.
vetura_prune_old_flash_images() {
  local dir="$1"
  [[ "${KEEP_OLD_IMAGES:-}" == "1" ]] && return 0
  [[ -d "${dir}" ]] || return 0
  local newest stem
  newest="$(ls -t "${dir}"/*.img.xz 2>/dev/null | head -1 || true)"
  [[ -n "${newest}" ]] || return 0
  stem="$(basename "${newest}" .img.xz)"
  find "${dir}" -maxdepth 1 -type f \( -name '*.img.xz' -o -name '*.img' -o -name '*.info' \) \
    ! -name "${stem}.img.xz" ! -name "${stem}.info" -print -delete
}

mkdir -p "${OUT_DIR}"
echo "==> Removing older flash images (KEEP_OLD_IMAGES=1 to keep them)"
vetura_prune_old_flash_images "${PIGEN_DIR}/deploy"
vetura_prune_old_flash_images "${OUT_DIR}"
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
  vetura_prune_old_flash_images "${PIGEN_DIR}/deploy"
  rm -rf "${OUT_DIR}"
  mkdir -p "${OUT_DIR}"
  cp -a "${PIGEN_DIR}/deploy/." "${OUT_DIR}/"
  vetura_prune_old_flash_images "${OUT_DIR}"
fi

echo "Done. Flash ${IMG_NAME} from ${OUT_DIR}/ (see README.md)."
