#!/usr/bin/env bash
# One-time Cloudflare setup (free plan, no card): D1 database, Pages project, Worker + cron, GitHub secrets.
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/setup-cloudflare.sh [pages-project-name]
#
# Token permissions (Account): Cloudflare Pages: Edit, Workers Scripts: Edit, D1: Edit, Account Settings: Read,
# Workers Tail: Read (optional). Idempotent: re-running reuses what already exists.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
PROJECT="${1:-tailtale}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "== D1"
DB_ID=$(cf "$API/d1/database?name=tailtale" | json "next((x['uuid'] for x in d['result'] if x['name']=='tailtale'), '')")
if [ -z "$DB_ID" ]; then
  DB_ID=$(cf -X POST "$API/d1/database" -d '{"name":"tailtale"}' | json "d['result']['uuid']")
  echo "created D1 tailtale $DB_ID"
else
  echo "using existing D1 tailtale $DB_ID"
fi

echo "== Pages project"
if ! cf "$API/pages/projects/$PROJECT" >/dev/null 2>&1; then
  cf -X POST "$API/pages/projects" -d "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}" >/dev/null
  echo "created Pages project $PROJECT"
fi
SUBDOMAIN=$(cf "$API/pages/projects/$PROJECT" | json "d['result']['subdomain']")
SITE="https://$SUBDOMAIN"
echo "site: $SITE"

echo "== workers.dev subdomain"
WD=$(cf "$API/workers/subdomain" 2>/dev/null | json "d['result']['subdomain']" || true)
if [ -z "$WD" ]; then
  WD="tailtale-$(openssl rand -hex 3)"
  cf -X PUT "$API/workers/subdomain" -d "{\"subdomain\":\"$WD\"}" >/dev/null
  echo "registered $WD.workers.dev"
fi

echo "== write config"
for f in "$ROOT/worker/wrangler.toml" "$ROOT/web/wrangler.toml"; do
  python3 - "$f" "$DB_ID" "$SITE" <<'PY'
import re, sys
p, db, site = sys.argv[1:]
s = open(p).read()
s = re.sub(r'database_id = "[^"]*"( #.*)?', f'database_id = "{db}"', s)
s = re.sub(r'PAGES_ORIGIN = "[^"]*"', f'PAGES_ORIGIN = "{site}"', s)
open(p, "w").write(s)
PY
done
if [ "$PROJECT" != "tailtale" ]; then
  sed -i.bak "s/^name = \"tailtale\"$/name = \"$PROJECT\"/" "$ROOT/web/wrangler.toml" && rm -f "$ROOT/web/wrangler.toml.bak"
fi

echo "== D1 migrations + Worker deploy"
( cd "$ROOT/worker" && npx wrangler d1 migrations apply tailtale --remote && npx wrangler deploy )

echo "== GitHub secrets and variables (needs gh auth + an existing repo)"
if command -v gh >/dev/null && gh repo view >/dev/null 2>&1; then
  gh secret set CLOUDFLARE_API_TOKEN --body "$CLOUDFLARE_API_TOKEN"
  gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CLOUDFLARE_ACCOUNT_ID"
  gh variable set TAILTALE_SITE_URL --body "$SITE"
  gh variable set PAGES_PROJECT --body "$PROJECT"
else
  echo "skipped (no gh repo); set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID secrets and TAILTALE_SITE_URL, PAGES_PROJECT variables by hand"
fi

echo
echo "Done. Site: $SITE   Worker: https://tailtale-api.$WD.workers.dev"
echo "Next: commit the updated wrangler.toml files, push, then run the 'Daily data + deploy' workflow."
