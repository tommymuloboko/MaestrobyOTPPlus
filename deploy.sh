#!/usr/bin/env bash
# Run on the VPS from the project root: sudo bash deploy.sh
# Requires Docker and the shared network maestro-sync_internal (created by the shared Caddy stack).
set -euo pipefail

if ! docker network inspect maestro-sync_internal >/dev/null 2>&1; then
  echo "Network maestro-sync_internal not found. Start the shared Caddy stack first." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.prod.example .env
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$(openssl rand -hex 24)/" .env
  sed -i "s/^SEED_PASSWORD=.*/SEED_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')/" .env
  echo "Created .env with generated secrets (SEED_PASSWORD is the password for the demo logins)."
fi

docker compose -f docker-compose.prod.yml --env-file .env up -d --build
docker compose -f docker-compose.prod.yml ps
echo "Now add the maestrobyotpplus.com block (see top of docker-compose.prod.yml) to the shared Caddyfile and reload Caddy."
