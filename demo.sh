#!/bin/bash
# Layaway demo doctor — checks & self-heals the demo stack.
# Usage: ./demo.sh          (from ~/layaway-pos)
set -u
cd "$(dirname "$0")"

ok()   { printf "  ✅ %s\n" "$1"; }
bad()  { printf "  ❌ %s\n" "$1"; }
info() { printf "  ➜  %s\n" "$1"; }

current_url() {
  grep -o 'SHOPIFY_APP_URL=https://[^ ]*' web/.env | cut -d= -f2
}

echo "── Layaway demo doctor ──────────────────────────"

# 1. Backend server on :3000
if curl -s --max-time 3 http://localhost:3000/healthz | grep -q '"ok":true'; then
  ok "backend server running on :3000"
else
  info "starting backend server..."
  ( cd web && nohup node --max-http-header-size=65536 index.js > /tmp/layaway_server.log 2>&1 & )
  sleep 3
  curl -s --max-time 3 http://localhost:3000/healthz | grep -q '"ok":true' \
    && ok "backend server started" || { bad "backend failed — see /tmp/layaway_server.log"; exit 1; }
fi

# 2. Tunnel reachable at the URL everything points to?
URL=$(current_url)
if curl -s --max-time 8 "$URL/healthz" | grep -q '"ok":true'; then
  ok "tunnel healthy: $URL"
  echo "─────────────────────────────────────────────────"
  echo "  All systems go. Demo away! 🎉"
  exit 0
fi

bad "tunnel dead at $URL — rebuilding..."

# 3. Fresh tunnel
pkill -f cloudflared 2>/dev/null; sleep 2
nohup cloudflared tunnel --url http://localhost:3000 > /tmp/layaway_tunnel.log 2>&1 &
sleep 8
NEW_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/layaway_tunnel.log | head -1)
[ -z "$NEW_URL" ] && { bad "could not start tunnel — see /tmp/layaway_tunnel.log"; exit 1; }
ok "new tunnel: $NEW_URL"

# 4. Re-point every place that bakes in the URL
OLD_HOST=$(echo "$URL" | sed 's|https://||')
NEW_HOST=$(echo "$NEW_URL" | sed 's|https://||')
sed -i '' "s|$OLD_HOST|$NEW_HOST|g" \
  web/.env shopify.app.toml \
  extensions/layaway/src/Modal.tsx \
  extensions/layaway-account/src/OrderStatusBlock.tsx
ok "re-pointed env, app config, POS + customer account extensions"

# 5. Restart server (picks up new SHOPIFY_APP_URL)
lsof -ti :3000 | xargs kill 2>/dev/null; sleep 2
( cd web && nohup node --max-http-header-size=65536 index.js > /tmp/layaway_server.log 2>&1 & )
sleep 3
curl -s --max-time 8 "$NEW_URL/healthz" | grep -q '"ok":true' \
  && ok "backend healthy through new tunnel" || { bad "backend not reachable via tunnel"; exit 1; }

# 6. Redeploy extensions with the new URL baked in
info "redeploying extensions (may prompt browser login if CLI session expired)..."
if shopify app deploy --allow-updates --message "demo.sh: tunnel rotated to $NEW_HOST" 2>&1 | grep -qE "layaway-pos-[0-9]+"; then
  ok "deployed"
else
  bad "deploy failed — run: shopify auth login   then re-run ./demo.sh"
  exit 1
fi

echo "─────────────────────────────────────────────────"
echo "  Healed. ⚠️  Force-quit & reopen the POS app and"
echo "  hard-refresh any customer account page so they"
echo "  pick up the new extension bundle."
