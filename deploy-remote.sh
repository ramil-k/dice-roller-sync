#!/bin/sh
# Runs on the server as the forced command of the GitHub Actions deploy key:
# pull the fresh main and restart the container.
set -eu
cd /opt/dice-roller-sync
git fetch origin main
git reset --hard origin/main
docker compose up -d --build
sleep 3
wget -qO- http://127.0.0.1:6120/health
echo " deploy ok: $(git rev-parse --short HEAD)"
