#!/usr/bin/env bash
# Generates a Dockerfile for each sample app with the built CLI, builds the image,
# runs it with a non-default $PORT and checks the HTTP response.
#
#   npm run build && scripts/docker-smoke.sh            # all apps
#   scripts/docker-smoke.sh spring-boot fastapi         # some apps
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/main.js"
APPS=("$@")
[ ${#APPS[@]} -eq 0 ] && APPS=(express fastapi go spring-boot vite)
PORT=8123
failed=()

[ -f "$CLI" ] || { echo "Build the CLI first: npm run build" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is not running" >&2; exit 1; }

for app in "${APPS[@]}"; do
  echo "::group::$app"
  work="$(mktemp -d)"
  cp -R "$ROOT/e2e/apps/$app" "$work/$app"
  tag="omnideploy-smoke-$app"
  container=""
  if (
    set -e
    cd "$work/$app"
    CI=1 node "$CLI" generate railway --yes
    docker build --quiet -t "$tag" .
    container="$(docker run -d -e PORT=$PORT -p $PORT:$PORT "$tag")"
    echo "$container" > "$work/cid"
    for _ in $(seq 1 60); do
      if body="$(curl -fsS "http://localhost:$PORT/" 2>/dev/null)"; then
        echo "$body" | grep -q "omnideploy smoke: $app" && exit 0
        echo "unexpected body: $body"; exit 1
      fi
      sleep 2
    done
    echo "no response on port $PORT"; docker logs "$container" | tail -30; exit 1
  ); then
    echo "✔ $app"
  else
    echo "✖ $app"; failed+=("$app")
  fi
  [ -f "$work/cid" ] && docker rm -f "$(cat "$work/cid")" >/dev/null 2>&1 || true
  rm -rf "$work"
  echo "::endgroup::"
done

if [ ${#failed[@]} -gt 0 ]; then echo "Failed: ${failed[*]}"; exit 1; fi
echo "All Docker smoke tests passed."
