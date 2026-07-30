#!/bin/bash
# Deploy Proxy Pool Manager on us2.
# Run this script on the server from /opt/proxy-pool-manager.

set -euo pipefail

cd /opt/proxy-pool-manager

printf '%s\n' 'Building Docker image...'
docker compose build

printf '%s\n' 'Starting container...'
docker compose up -d

printf '%s\n' 'Waiting for health check...'
ready=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://localhost:3000/healthz >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done

if [[ $ready != true ]]; then
  echo 'Service did not become healthy. Inspect docker compose logs proxy-pool without sharing secrets.' >&2
  exit 1
fi

if ! docker compose logs --tail=100 proxy-pool 2>&1 | grep -Fq 'Authentication configuration valid'; then
  echo 'Service is healthy but authentication configuration did not confirm startup. Inspect docker compose logs proxy-pool locally.' >&2
  exit 1
fi

if [[ -n "${LOGIN_SMOKE_USERNAME:-}" || -n "${LOGIN_SMOKE_PASSWORD:-}" ]]; then
  if [[ -z "${LOGIN_SMOKE_USERNAME:-}" || -z "${LOGIN_SMOKE_PASSWORD:-}" ]]; then
    echo 'Both LOGIN_SMOKE_USERNAME and LOGIN_SMOKE_PASSWORD are required for the login smoke test.' >&2
    exit 1
  fi

  login_payload=$(node -e 'process.stdout.write(JSON.stringify({username: process.env.LOGIN_SMOKE_USERNAME, password: process.env.LOGIN_SMOKE_PASSWORD}))')
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    --data "$login_payload" \
    http://localhost:3000/login)
  unset login_payload

  if [[ $status != 200 ]]; then
    echo "Login smoke test failed with HTTP $status." >&2
    exit 1
  fi
  echo 'Login smoke test passed.'
else
  echo 'Login smoke test skipped (set LOGIN_SMOKE_USERNAME and LOGIN_SMOKE_PASSWORD outside .env to enable it).'
fi

echo 'Deployment complete. Service and authentication configuration are healthy.'
