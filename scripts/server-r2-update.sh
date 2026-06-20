#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/NJAU-Libyy}"
R2_PUBLIC_BASE_URL="${R2_PUBLIC_BASE_URL:-https://cloud.way2api.fun/NJAU}"
CHANNEL="${CHANNEL:-latest}"
ARIA2_CONNECTIONS="${ARIA2_CONNECTIONS:-16}"
IMAGE_RETENTION_COUNT="${IMAGE_RETENTION_COUNT:-2}"

for command in aria2c curl docker gzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[deploy] Missing required command: $command" >&2
    exit 1
  fi
done

mkdir -p "$APP_DIR/releases" "$APP_DIR/backups"
cd "$APP_DIR"

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[deploy] Created .env from .env.example. Please review it before exposing the service."
fi

MANIFEST_URL="$R2_PUBLIC_BASE_URL/$CHANNEL/manifest.json"
MANIFEST_PATH="$APP_DIR/releases/manifest-$CHANNEL.json"

echo "[deploy] Fetching $MANIFEST_URL"

download() {
  local url="$1"
  local output="$2"
  local output_dir
  local output_name
  output_dir="$(dirname "$output")"
  output_name="$(basename "$output")"
  mkdir -p "$output_dir"
  echo "[deploy] Downloading $url"
  aria2c \
    --allow-overwrite=true \
    --auto-file-renaming=false \
    --check-certificate=true \
    --continue=true \
    --disable-ipv6=true \
    --file-allocation=none \
    --max-connection-per-server="$ARIA2_CONNECTIONS" \
    --min-split-size=1M \
    --retry-wait=3 \
    --split="$ARIA2_CONNECTIONS" \
    --timeout=60 \
    --max-tries=5 \
    --dir="$output_dir" \
    --out="$output_name" \
    "$url"
}

normalize_image_retention_count() {
  if ! printf '%s\n' "$IMAGE_RETENTION_COUNT" | grep -Eq '^[0-9]+$'; then
    echo "[deploy] Invalid IMAGE_RETENTION_COUNT=$IMAGE_RETENTION_COUNT, using 2" >&2
    IMAGE_RETENTION_COUNT=2
  fi

  if [ "$IMAGE_RETENTION_COUNT" -lt 1 ]; then
    IMAGE_RETENTION_COUNT=1
  fi
}

cleanup_old_docker_images() {
  normalize_image_retention_count

  local keep_tags
  local kept_count
  local tag
  local removed_count

  keep_tags=" $VERSION "
  kept_count=1
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    [ "$tag" != "$VERSION" ] || continue

    if [ "$kept_count" -lt "$IMAGE_RETENTION_COUNT" ]; then
      keep_tags="${keep_tags}${tag} "
      kept_count=$((kept_count + 1))
    fi
  done < <(docker image ls njau-libyy-app --format '{{.Tag}}' | grep -E '^[0-9a-f]{12}$' || true)

  removed_count=0
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    case "$keep_tags" in
      *" $tag "*) continue ;;
    esac

    echo "[deploy] Removing old Docker image tag njau-libyy-app:$tag"
    if docker image rm "njau-libyy-app:$tag"; then
      removed_count=$((removed_count + 1))
    else
      echo "[deploy] Could not remove njau-libyy-app:$tag; it may still be in use" >&2
    fi
  done < <(docker image ls njau-libyy-app --format '{{.Tag}}' | grep -E '^[0-9a-f]{12}$' || true)

  echo "[deploy] Removed $removed_count old Docker image tag(s)"
}

cleanup_old_release_archives() {
  normalize_image_retention_count

  local archive
  local basename
  local version
  local keep_versions
  local kept_count
  local removed_count

  keep_versions=" $VERSION "
  kept_count=1
  while IFS= read -r archive; do
    [ -n "$archive" ] || continue
    basename="$(basename "$archive")"
    version="${basename#njau-libyy-app-}"
    version="${version%.tar.gz}"
    [ "$version" != "$VERSION" ] || continue

    if [ "$kept_count" -lt "$IMAGE_RETENTION_COUNT" ]; then
      keep_versions="${keep_versions}${version} "
      kept_count=$((kept_count + 1))
    fi
  done < <(find "$APP_DIR/releases" -maxdepth 1 -type f -name 'njau-libyy-app-*.tar.gz' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)

  removed_count=0
  while IFS= read -r archive; do
    [ -n "$archive" ] || continue
    basename="$(basename "$archive")"
    version="${basename#njau-libyy-app-}"
    version="${version%.tar.gz}"
    case "$keep_versions" in
      *" $version "*) continue ;;
    esac

    echo "[deploy] Removing old release archive $archive"
    rm -f "$archive" "$archive.aria2"
    removed_count=$((removed_count + 1))
  done < <(find "$APP_DIR/releases" -maxdepth 1 -type f -name 'njau-libyy-app-*.tar.gz' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)

  echo "[deploy] Removed $removed_count old release archive(s)"
}

rm -f "$MANIFEST_PATH" "$MANIFEST_PATH.aria2"
download "$MANIFEST_URL" "$MANIFEST_PATH"

json_value() {
  local key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$MANIFEST_PATH" | head -n 1
}

VERSION="$(json_value version)"
IMAGE_OBJECT="$(json_value image)"
COMPOSE_OBJECT="$(json_value compose)"
SECCOMP_OBJECT="$(json_value seccomp)"
ENV_EXAMPLE_OBJECT="$(json_value envExample)"

if [ -z "$VERSION" ] || [ -z "$IMAGE_OBJECT" ] || [ -z "$COMPOSE_OBJECT" ] || [ -z "$SECCOMP_OBJECT" ] || [ -z "$ENV_EXAMPLE_OBJECT" ]; then
  echo "[deploy] Invalid manifest: $MANIFEST_PATH" >&2
  exit 1
fi

IMAGE_PATH="$APP_DIR/releases/$IMAGE_OBJECT"
COMPOSE_PATH="$APP_DIR/docker-compose.yml"
SECCOMP_PATH="$APP_DIR/docker/playwright-seccomp.json"

echo "[deploy] Version $VERSION"

CURRENT_VERSION=""
if [ -f "$APP_DIR/.deployed-version" ]; then
  CURRENT_VERSION="$(cat "$APP_DIR/.deployed-version" | head -n 1)"
fi

if [ "$CURRENT_VERSION" = "$VERSION" ] && curl --http1.1 -4 -fsS --connect-timeout 5 --max-time 15 http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1; then
  echo "[deploy] Already running $VERSION"
  cleanup_old_docker_images
  cleanup_old_release_archives
  exit 0
fi

download "$R2_PUBLIC_BASE_URL/$CHANNEL/$IMAGE_OBJECT" "$IMAGE_PATH"
download "$R2_PUBLIC_BASE_URL/$CHANNEL/$COMPOSE_OBJECT" "$COMPOSE_PATH"
mkdir -p "$APP_DIR/docker"
download "$R2_PUBLIC_BASE_URL/$CHANNEL/$SECCOMP_OBJECT" "$SECCOMP_PATH"
download "$R2_PUBLIC_BASE_URL/$CHANNEL/$ENV_EXAMPLE_OBJECT" "$APP_DIR/.env.example"

if [ ! -s "$SECCOMP_PATH" ]; then
  echo "[deploy] Missing Playwright seccomp profile: $SECCOMP_PATH" >&2
  exit 1
fi

printf 'APP_IMAGE_TAG=%s\n' "$VERSION" > "$APP_DIR/.release.env"
echo "[deploy] Validating compose file"
docker compose --env-file .env --env-file .release.env config >/dev/null
if ! docker compose --env-file .env --env-file .release.env config | grep -q 'seccomp:./docker/playwright-seccomp.json'; then
  echo "[deploy] Compose does not enable the Playwright seccomp profile" >&2
  exit 1
fi

if docker compose ps -q app >/dev/null 2>&1; then
  CONTAINER_ID="$(docker compose ps -q app || true)"
  if [ -n "$CONTAINER_ID" ]; then
    docker cp "$CONTAINER_ID":/data/njau-libyy.sqlite "$APP_DIR/backups/njau-libyy-$(date +%F-%H%M%S).sqlite" || true
  fi
fi

echo "[deploy] Loading image"
gzip -dc "$IMAGE_PATH" | docker load

export APP_IMAGE_TAG="$VERSION"

echo "[deploy] Starting compose"
docker compose --env-file .env --env-file .release.env up -d tailscale
docker compose --env-file .env --env-file .release.env up -d --no-deps --force-recreate app
docker compose ps
curl --http1.1 -4 -fsS http://127.0.0.1:3000/api/v1/health
echo
printf '%s\n' "$VERSION" > "$APP_DIR/.deployed-version"
cleanup_old_docker_images
cleanup_old_release_archives
echo "[deploy] Updated to $VERSION"
