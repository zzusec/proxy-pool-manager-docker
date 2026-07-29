#!/usr/bin/env bash
# Post-deploy verification for the filtered-test + Linux.do public RSS change set.
# Runs ON the server. Reads credentials from .env and never prints them.
set -uo pipefail
cd /opt/proxy-pool-manager

BASE="http://127.0.0.1:3000"
FEED_URL="${FEED_URL:-https://linux.do/latest.rss}"

# Parse only the keys we need. Sourcing .env directly would glob-expand
# unquoted values such as CRON_SCHEDULE=*/10 * * * *.
envval() { sed -n "s/^$1=//p" .env | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
ADMIN_USERNAME=$(envval ADMIN_USERNAME)
ADMIN_PASSWORD=$(envval ADMIN_PASSWORD)
API_KEY=$(envval API_KEY)

say() { printf '\n=== %s ===\n' "$*"; }

say "healthz"
curl -s -o /dev/null -w 'health=%{http_code}\n' "$BASE/healthz"

say "schema migration over existing volume"
docker compose exec -T proxy-pool sh -c 'cat > /app/data/inspect-db.mjs' < scripts/inspect-db.mjs
docker compose exec -T proxy-pool node /app/data/inspect-db.mjs

say "login"
TOKEN=$(curl -s -X POST "$BASE/login" -H 'Content-Type: application/json' \
  --data-binary "$(jq -nc --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" '{username:$u,password:$p}')" \
  | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then echo "login=FAILED"; exit 1; fi
echo "login=ok (token length ${#TOKEN})"
AUTH="Authorization: Bearer $TOKEN"

say "auth boundary"
curl -s -o /dev/null -w 'GET /api/rss/feeds unauthenticated=%{http_code}\n' "$BASE/api/rss/feeds"
curl -s -o /dev/null -w 'GET /api/v1/rss/feeds no-api-key=%{http_code}\n' "$BASE/api/v1/rss/feeds"
curl -s -o /dev/null -w 'GET /api/rss/feeds with token=%{http_code}\n' -H "$AUTH" "$BASE/api/rss/feeds"

say "URL policy rejections"
for body in \
  '{"url":"https://example.com/latest.rss"}' \
  '{"url":"http://linux.do/latest.rss"}' \
  '{"url":"https://linux.do/latest.rss?x=1"}' \
  '{"url":"https://linux.do:8443/latest.rss"}' \
  '{"url":"https://user:pw@linux.do/latest.rss"}' \
  '{"url":"https://linux.do/latest.json"}' \
  '{"url":"https://linux.do/latest.rss","pollIntervalMinutes":5}' \
  '{"url":"https://linux.do/latest.rss","protocol":"ftp"}' ; do
  printf '%-62s -> %s\n' "$body" \
    "$(curl -s -X POST "$BASE/api/rss/feeds" -H "$AUTH" -H 'Content-Type: application/json' -d "$body" | jq -c '.error // .ok')"
done

say "add feed $FEED_URL"
FEED_ID=$(curl -s -H "$AUTH" "$BASE/api/rss/feeds" | jq -r --arg u "$FEED_URL" '.feeds[] | select(.url==$u) | .id' | head -1)
if [ -n "$FEED_ID" ]; then
  echo "reusing existing feed $FEED_ID"
else
  FEED_ID=$(curl -s -X POST "$BASE/api/rss/feeds" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$FEED_URL" '{url:$u,label:"Linux.do 最新主题",group:"linuxdo-rss",protocol:"http",pollIntervalMinutes:60}')" \
    | jq -r '.feed.id // empty')
fi
if [ -z "$FEED_ID" ]; then echo "add feed=FAILED"; exit 1; fi
echo "feed id=$FEED_ID"

say "manual fetch"
curl -s -X POST "$BASE/api/rss/feeds/$FEED_ID/fetch" -H "$AUTH" | jq -c .
for i in $(seq 1 24); do
  sleep 5
  STATUS=$(curl -s -H "$AUTH" "$BASE/api/rss/feeds" | jq -r --arg id "$FEED_ID" '.feeds[] | select(.id==$id) | .lastStatus // "idle"')
  echo "poll $i lastStatus=$STATUS"
  case "$STATUS" in fetching|idle) ;; *) break ;; esac
done

say "feed state"
curl -s -H "$AUTH" "$BASE/api/rss/feeds" | jq --arg id "$FEED_ID" '.feeds[] | select(.id==$id)
  | {url, enabled, lastStatus, lastError, lastCheckedAt, lastSuccessAt, consecutiveFailures,
     itemStatusCounts: (.items | group_by(.status) | map({key: .[0].status, value: length}) | from_entries),
     sampleItems: (.items | map({title, status, extractedCount, importTaskId, error}) | .[0:6])}'

say "import queue"
curl -s -H "$AUTH" "$BASE/api/import/queue" | jq -c '{pending: ((.queue // []) | length), rss: ((.queue // []) | map(select(.sourceType=="rss")) | length)}'

say "db state after fetch"
docker compose exec -T proxy-pool node /app/data/inspect-db.mjs 2>&1 | grep -E "rss item statuses|source buckets|recent rss proxies|recent import history|counts"

say "filtered test entry point"
for f in 'alive=false' 'alive=null' ''; do
  printf '%-12s total=%s\n' "${f:-all}" "$(curl -s -H "$AUTH" "$BASE/api/proxies?limit=1&$f" | jq -r '.total')"
done
NEEDLE=$(curl -s -H "$AUTH" "$BASE/api/proxies?limit=1" | jq -r '.proxies[0].ip // empty')
if [ -n "$NEEDLE" ]; then
  echo "scope=filtered with search=$NEEDLE (narrow on purpose; 1000-cap path proven in unit tests):"
  curl -s -X POST "$BASE/api/proxies/test" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$NEEDLE" '{scope:"filtered",filters:{search:$s}}')" \
    | jq -c '{message, scope, total, limit, truncated, jobId: .job.id}'
else
  echo "no proxies present to test against"
fi

say "invalid filter is rejected"
curl -s -X POST "$BASE/api/proxies/test" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"scope":"filtered","filters":{"alive":"maybe"}}' | jq -c '.error'

say "v1 surface carries no rss/source metadata"
curl -s -H "Authorization: Bearer $API_KEY" "$BASE/api/v1/proxies?limit=1" \
  | jq -c '{keys: ((.proxies[0] // {}) | keys), leaks: ((.proxies[0] // {}) | keys | map(select(test("source|rss|feed|etag";"i"))))}'

say "container log tail"
docker compose logs --tail 25 proxy-pool 2>&1 | sed -E 's/(Bearer|token=|password=)[^ ]*/\1***/gi'

say "done"
