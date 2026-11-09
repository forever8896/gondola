#!/usr/bin/env bash
# One-time setup for Gondola: checks prerequisites, writes .env with fresh secrets, starts Postgres.
# Safe to re-run: it never overwrites an existing .env.
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✖\033[0m %s\n' "$1"; exit 1; }
rand() { bun -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

echo "Gondola setup"
echo
echo "1. Prerequisites"
command -v bun >/dev/null    && ok "bun $(bun --version)"            || fail "bun not found: curl -fsSL https://bun.sh/install | bash"
command -v docker >/dev/null && ok "docker $(docker --version | awk '{print $3}' | tr -d ,)" || fail "docker not found: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 && ok "docker compose" || fail "docker compose plugin not found"
command -v boat >/dev/null   && ok "boat CLI $(boat --version 2>/dev/null | awk '{print $2}')" || fail "boat CLI not found: see https://docs.boat.dev"
if boat status --json 2>/dev/null | grep -q '"loginState":"active"'; then ok "signed in to Boat"; else fail "not signed in to Boat: run 'boat login' (or 'boat onboard'), then re-run setup"; fi

echo
echo "2. Configuration (.env)"
if [ -f .env ]; then
  ok ".env already exists, leaving it as it is"
else
  cp .env.example .env
  chmod 600 .env
  PG=$(rand 24); SECRET=$(rand 32); ADMIN=$(rand 24)
  sed -i.bak -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$PG/" \
             -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://gondola:$PG@127.0.0.1:5544/gondola#" \
             -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$SECRET/" \
             -e "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$ADMIN/" .env && rm -f .env.bak
  ok "created .env with fresh database password, session secret and admin token"

  echo
  echo "  Gondola's agents use models through OpenRouter (https://openrouter.ai/keys)."
  read -r -s -p "  Paste your OpenRouter API key (input hidden): " KEY; echo
  if [ -n "$KEY" ]; then
    if curl -sf https://openrouter.ai/api/v1/key -H "Authorization: Bearer $KEY" >/dev/null; then
      sed -i.bak "s#^OPENROUTER_API_KEY=.*#OPENROUTER_API_KEY=$KEY#" .env && rm -f .env.bak
      ok "OpenRouter key works and is saved in .env"
      echo
      echo "  The agents run inside Boat sandboxes, so Boat needs the key too (stored in your Boat AI profile)."
      read -r -p "  Store it in your default Boat AI profile now? [y/N] " YES
      if [ "${YES:-n}" = "y" ] || [ "${YES:-n}" = "Y" ]; then
        printf '%s' "$KEY" | boat ai profile set-key default openrouter-api-key - >/dev/null && ok "key stored in Boat profile 'default'"
      else
        warn "skipped: run 'boat ai profile set-key default openrouter-api-key' yourself before the first run"
      fi
    else
      warn "that key was rejected by OpenRouter; add a working one to OPENROUTER_API_KEY in .env"
    fi
  else
    warn "no key entered; add it to OPENROUTER_API_KEY in .env"
  fi
fi

echo
echo "3. Database"
docker compose up -d --wait >/dev/null 2>&1 || docker compose up -d >/dev/null
for _ in $(seq 1 30); do docker exec gondola-db pg_isready -U gondola -d gondola >/dev/null 2>&1 && break; sleep 1; done
docker exec gondola-db pg_isready -U gondola -d gondola >/dev/null 2>&1 && ok "Postgres is up on 127.0.0.1:5544" || fail "Postgres did not start: docker compose logs db"

echo
echo "4. Checks"
bun scripts/doctor.ts || true

echo
echo "Done. Start Gondola with:  bun run start   then open http://localhost:8787"
