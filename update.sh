#!/bin/bash
# update.sh — rebuild and recreate the tesla-drive container.
#
# For hosts WITHOUT docker compose: pulls the latest code, rebuilds
# the image, removes the old container and starts a fresh one with
# the project's standard settings. Safe to re-run.
#
# Access-gate token: the gate only turns on when TESLA_ACCESS_TOKEN
# reaches the container. This script takes it from (first match):
#   1. the TESLA_ACCESS_TOKEN environment variable, if exported, or
#   2. a line `TESLA_ACCESS_TOKEN=...` in a file named `.env` sitting
#      next to this script. (.env is gitignored — it never leaves
#      this machine, which matters: this repo is public.)
# With no token found, the script still runs but warns loudly, so the
# gate never silently ends up off again.
set -eu
cd "$(dirname "$0")"

echo "==> Pulling latest code"
git pull --ff-only

# --- resolve the access token -------------------------------------
TOKEN="${TESLA_ACCESS_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env ]; then
  TOKEN="$(grep -E '^[[:space:]]*TESLA_ACCESS_TOKEN[[:space:]]*=' .env | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
fi

echo "==> Building image"
docker build -t tesla-drive .

echo "==> Recreating container"
docker rm -f tesla-drive 2>/dev/null || true

RUN_ARGS="-d --name tesla-drive --restart unless-stopped -p 8742:8742
  -e PORT=8742 -e HOST=0.0.0.0 -e YT_DLP_COOKIES=/config/cookies.txt
  -v $PWD/config:/config"

if [ -n "$TOKEN" ]; then
  # Intentionally unquoted: RUN_ARGS is a flag list.
  docker run $RUN_ARGS -e "TESLA_ACCESS_TOKEN=$TOKEN" tesla-drive
else
  echo ""
  echo "!! WARNING: no TESLA_ACCESS_TOKEN found in the environment or .env"
  echo "!! The access gate will be OFF and the site publicly open."
  echo "!! To enable it:  echo 'TESLA_ACCESS_TOKEN=<your-token>' > .env"
  echo "!! then re-run this script."
  echo ""
  docker run $RUN_ARGS tesla-drive
fi

echo "==> Verifying"
sleep 2
docker logs tesla-drive 2>&1 | grep -E 'Gate|running on' || true
echo ""
echo "Done. If you set a NEW token, open this once in the car browser:"
echo "  https://<your-domain>/?key=<your-token>"
echo "(An unchanged token needs nothing — the car already remembers it.)"
