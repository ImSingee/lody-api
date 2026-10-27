#!/bin/sh
set -eu

: "${LODY_DATA_DIR:=/data/lody}"
: "${API_DATA_DIR:=/data/api}"

for dir in "$LODY_DATA_DIR" "$API_DATA_DIR"; do
  mkdir -p "$dir"
  if [ ! -w "$dir" ]; then
    echo "entrypoint: $dir is not writable by uid $(id -u); fix the volume ownership" >&2
    exit 1
  fi
done

if [ -z "${API_KEYS:-}" ]; then
  echo "entrypoint: API_KEYS is required" >&2
  exit 1
fi

# The server logs in to lody itself (lody login --auth "$LODY_CLI_API_KEY"),
# skipping the login when the saved credentials already hold that key.
exec node /app/dist/index.js "$@"
