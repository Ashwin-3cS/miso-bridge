#!/usr/bin/env bash
# Local Postgres for development and integration tests.
#
# Uses the compose file where the compose plugin exists, and the same image
# directly where it does not, so a developer does not have to care which.
set -euo pipefail

name=miso-bridge-postgres
image=postgres:17-alpine
port=5433

have_compose() { docker compose version >/dev/null 2>&1; }

case "${1:-up}" in
up)
  if have_compose; then
    docker compose up -d postgres
  elif docker start "$name" >/dev/null 2>&1; then
    echo "started $name"
  else
    docker run -d --name "$name" \
      -e POSTGRES_USER=bridge \
      -e POSTGRES_PASSWORD=bridge \
      -e POSTGRES_DB=bridge \
      -p "$port:5432" \
      -v miso-bridge-pgdata:/var/lib/postgresql/data \
      "$image" >/dev/null
    echo "created $name"
  fi
  for _ in $(seq 1 60); do
    if docker exec "$(have_compose && docker compose ps -q postgres || echo "$name")" \
      pg_isready -U bridge -d bridge >/dev/null 2>&1; then
      echo "postgres ready on $port"
      exit 0
    fi
    sleep 1
  done
  echo "postgres did not become ready" >&2
  exit 1
  ;;
down)
  if have_compose; then
    docker compose down
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "removed $name"
  fi
  ;;
*)
  echo "usage: $0 [up|down]" >&2
  exit 2
  ;;
esac
