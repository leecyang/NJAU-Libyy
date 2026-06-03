#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/NJAU-Libyy}"
R2_PUBLIC_BASE_URL="${R2_PUBLIC_BASE_URL:-https://cloud.way2api.fun/NJAU}"
CHANNEL="${CHANNEL:-latest}"

mkdir -p "$APP_DIR/releases" "$APP_DIR/backups"
cd "$APP_DIR"

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[deploy] Created .env from .env.example. Please review it before exposing the service."
fi

MANIFEST_URL="$R2_PUBLIC_BASE_URL/$CHANNEL/manifest.json"
MANIFEST_PATH="$APP_DIR/releases/manifest-$CHANNEL.json"

echo "[deploy] Fetching $MANIFEST_URL"
curl -fsSL "$MANIFEST_URL" -o "$MANIFEST_PATH"

json_value() {
  local key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$MANIFEST_PATH" | head -n 1
}

VERSION="$(json_value version)"
IMAGE_OBJECT="$(json_value image)"
COMPOSE_OBJECT="$(json_value compose)"
ENV_EXAMPLE_OBJECT="$(json_value envExample)"

if [ -z "$VERSION" ] || [ -z "$IMAGE_OBJECT" ] || [ -z "$COMPOSE_OBJECT" ] || [ -z "$ENV_EXAMPLE_OBJECT" ]; then
  echo "[deploy] Invalid manifest: $MANIFEST_PATH" >&2
  exit 1
fi

IMAGE_PATH="$APP_DIR/releases/$IMAGE_OBJECT"
COMPOSE_PATH="$APP_DIR/docker-compose.yml"

echo "[deploy] Version $VERSION"

CURRENT_VERSION=""
if [ -f "$APP_DIR/.release.env" ]; then
  CURRENT_VERSION="$(sed -n 's/^APP_IMAGE_TAG=//p' "$APP_DIR/.release.env" | head -n 1)"
fi

if [ "$CURRENT_VERSION" = "$VERSION" ] && curl -fsS --connect-timeout 5 --max-time 15 http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1; then
  echo "[deploy] Already running $VERSION"
  exit 0
fi

download() {
  local url="$1"
  local output="$2"
  echo "[deploy] Downloading $url"
  curl --fail --location --continue-at - --connect-timeout 15 --max-time 1800 --progress-bar "$url" -o "$output"
  echo
}

download "$R2_PUBLIC_BASE_URL/$CHANNEL/$IMAGE_OBJECT" "$IMAGE_PATH"
download "$R2_PUBLIC_BASE_URL/$CHANNEL/$COMPOSE_OBJECT" "$COMPOSE_PATH"
download "$R2_PUBLIC_BASE_URL/$CHANNEL/$ENV_EXAMPLE_OBJECT" "$APP_DIR/.env.example"

if docker compose ps -q app >/dev/null 2>&1; then
  CONTAINER_ID="$(docker compose ps -q app || true)"
  if [ -n "$CONTAINER_ID" ]; then
    docker cp "$CONTAINER_ID":/data/njau-libyy.sqlite "$APP_DIR/backups/njau-libyy-$(date +%F-%H%M%S).sqlite" || true
  fi
fi

echo "[deploy] Loading image"
gzip -dc "$IMAGE_PATH" | docker load

export APP_IMAGE_TAG="$VERSION"
printf 'APP_IMAGE_TAG=%s\n' "$VERSION" > "$APP_DIR/.release.env"

echo "[deploy] Starting compose"
docker compose --env-file .env --env-file .release.env up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/v1/health
echo
echo "[deploy] Updated to $VERSION"
