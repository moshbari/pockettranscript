#!/bin/bash
# Gives Get Transcript its OWN transcriber on Railway (service "transcriber" in
# the pockettranscript project), on Get Transcript's own OpenAI key.
#   1. copies the proxy / home-helper / cookie settings from the old shared transcriber
#   2. deploys the transcriber code (pulltranscript/transcriber) as the new service
#   3. gives it the clean address gettranscript-transcriber.up.railway.app
#   4. tests it live; ONLY if the test passes, points Get Transcript at it
#   5. adds it to the home YouTube helper's list and restarts the helper
# No key or token is ever printed. Safe to run again.
set -uo pipefail
R=~/.npm-global/bin/railway
BASE="/Volumes/Predator SSD GM& 1TB/Claude Cowork Projects"
POCKET="$BASE/pockettranscript"
OLD="$BASE/pulltranscript/transcriber"
PROJECT=6151f5c0-aa8c-4131-b331-b1b06c08996a
SVC=transcriber
LABEL=gettranscript-transcriber
NEW="https://$LABEL.up.railway.app"
OLD_URL="https://transcriber-production-f2f1.up.railway.app"
say() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*"; exit 1; }

source ~/.config/gettranscript-openai.env
[ -n "${GETTRANSCRIPT_OPENAI_KEY:-}" ] || die "Get Transcript key not found in ~/.config/gettranscript-openai.env"

say "Reading settings from the old transcriber"
OLDVARS=$(cd "$OLD" && $R variables --kv 2>/dev/null) || die "could not read the old transcriber's settings"
oldvar() { printf '%s\n' "$OLDVARS" | grep "^$1=" | head -1 | cut -d= -f2-; }

cd "$POCKET" || die "pockettranscript folder missing"

say "Creating the service (skipped if it already exists)"
if ! $R variables --service "$SVC" --kv >/dev/null 2>&1; then
  $R add --service "$SVC" >/dev/null || die "could not create the service"
fi

say "Setting its keys"
setv() { printf %s "$2" | $R variable set "$1" --stdin --service "$SVC" --skip-deploys >/dev/null || die "could not set $1"; echo "  $1 ✓"; }
setv OPENAI_API_KEY "$GETTRANSCRIPT_OPENAI_KEY"
for k in PROXY_URL HOME_WORKER_TOKEN YTDLP_COOKIES_B64; do
  v=$(oldvar "$k"); [ -n "$v" ] && setv "$k" "$v" || echo "  $k (not on the old one, skipped)"
done

say "Deploying the transcriber code"
$R up "$OLD" --path-as-root --service "$SVC" --detach >/dev/null || die "deploy failed to start"

say "Giving it the address $NEW"
DOM=$($R domain --service "$SVC" --json 2>/dev/null)
if ! printf '%s' "$DOM" | grep -q "$LABEL"; then
  ID=$(printf '%s' "$DOM" | python3 -c 'import sys,json
d=json.load(sys.stdin)
def find(o):
  if isinstance(o,dict):
    if "id" in o and any("railway.app" in str(v) for v in o.values()): return o["id"]
    for v in o.values():
      r=find(v)
      if r: return r
  if isinstance(o,list):
    for v in o:
      r=find(v)
      if r: return r
print(find(d) or "")')
  [ -n "$ID" ] && $R domain update "$ID" --domain "$LABEL" --service "$SVC" >/dev/null && echo "  address set ✓" || echo "  ⚠ couldn't rename the address automatically (Claude will fix it)"
fi

say "Waiting for it to come up (a first build takes 2-4 minutes)"
up=""
for i in $(seq 1 40); do
  curl -s --max-time 10 "$NEW/" | grep -q "running" && { up=1; break; }
  sleep 10
done
[ -n "$up" ] || die "new transcriber didn't answer at $NEW yet. Nothing was switched; Get Transcript still uses the old one."
echo "  it's up ✓"

say "Live test: a YouTube transcript through the new transcriber"
T=$(curl -s --max-time 240 -X POST "$NEW/transcribe" -H 'Content-Type: application/json' -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}')
printf '%s' "$T" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("text"); print("  got", len(d["text"].split()), "words via", d.get("source") or "whisper", "✓")' \
  || die "test transcript failed. Nothing was switched; Get Transcript still uses the old one."

say "Pointing Get Transcript at its own transcriber (server restarts, ~1 min)"
printf %s "$NEW" | $R variable set TRANSCRIBER_URL --stdin --service pockettranscript >/dev/null || die "could not switch Get Transcript"
echo "  switched ✓"

say "Adding it to the home YouTube helper"
HW=~/.config/home-worker.env
if ! grep -q "$LABEL" "$HW"; then
  grep -v '^SERVERS=' "$HW" > "$HW.tmp"
  echo "SERVERS=https://video-processor-staging.up.railway.app,$OLD_URL,$NEW" >> "$HW.tmp"
  mv "$HW.tmp" "$HW"; chmod 600 "$HW"
fi
pkill -f "^/usr/local/bin/node worker.js$" && echo "  helper restarted ✓" || echo "  (helper wasn't running)"

printf '\n✅ Done. Get Transcript now has its own transcriber at %s on its own OpenAI key.\n   The old shared transcriber keeps running for the other apps.\n' "$NEW"
