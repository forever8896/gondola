#!/bin/sh
# Restart a background Gondola server (dev helper). Refuses while a run is in flight: a restart fails in-flight runs.
cd "$(dirname "$0")/.."
busy=$(docker exec gondola-db psql -U gondola -d gondola -tAc "select count(*) from runs where status in ('queued','ingesting','building')" 2>/dev/null || echo 0)
[ "$busy" = "0" ] || { echo "refusing: $busy run(s) in flight"; exit 1; }
mkdir -p tmp
[ -f tmp/server.pid ] && kill "$(cat tmp/server.pid)" 2>/dev/null && sleep 1
setsid bun src/server.ts > tmp/server.log 2>&1 < /dev/null &
echo $! > tmp/server.pid
sleep 3; cat tmp/server.log
