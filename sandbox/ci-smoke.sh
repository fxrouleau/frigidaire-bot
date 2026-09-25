#!/bin/sh
# Starts the given sandbox image with the same hardening as docker-compose.yaml and runs smoke_test.py
# against it: the gate an image should pass before it is trusted or pushed (needs Docker and python3).
#   docker build -t frigidaire-sandbox:ci sandbox && sandbox/ci-smoke.sh frigidaire-sandbox:ci
set -eu

IMAGE="$1"
NAME="sandbox-smoke-$$"
TOKEN="smoke-$$"
HERE="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- sandbox logs ---"
    docker logs "$NAME" 2>&1 | tail -100 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$NAME" \
  --read-only \
  --tmpfs /tmp:size=256m,mode=1777,exec \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --memory 1g --cpus 1 --pids-limit 256 \
  -e SANDBOX_TOKEN="$TOKEN" \
  -p 127.0.0.1:18080:8080 \
  "$IMAGE" >/dev/null

python3 "$HERE/smoke_test.py" http://127.0.0.1:18080 --token "$TOKEN" --hardened
