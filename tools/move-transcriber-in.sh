#!/bin/bash
# ONE server for Get Transcript: the transcriber now lives inside the Get
# Transcript server (./transcriber). This script:
#   1. copies the proxy / home-helper / YouTube-cookie settings from the old
#      shared transcriber onto the Get Transcript server (never printed)
#   2. deploys the Get Transcript server (now built with ffmpeg + yt-dlp)
#   3. tests a real spoken audio file through it (Whisper on its own key)
#   4. if the test fails, points it back at the old transcriber so nothing breaks
#   5. adds it to the home YouTube helper's list and restarts the helper
set -uo pipefail
R=~/.npm-global/bin/railway
BASE="/Volumes/Predator SSD GM& 1TB/Claude Cowork Projects"
POCKET="$BASE/pockettranscript"
OLD="$BASE/pulltranscript/transcriber"
OLD_URL="https://transcriber-production-f2f1.up.railway.app"
SITE="https://pocket.99dfy.com"
SVC=pockettranscript
say_() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*"; exit 1; }

say_ "Copying settings from the old transcriber"
OLDVARS=$(cd "$OLD" && $R variables --kv 2>/dev/null) || die "could not read the old transcriber's settings"
cd "$POCKET" || die "pockettranscript folder missing"
for k in PROXY_URL HOME_WORKER_TOKEN YTDLP_COOKIES_B64; do
  v=$(printf '%s\n' "$OLDVARS" | grep "^$k=" | head -1 | cut -d= -f2-)
  if [ -n "$v" ]; then printf %s "$v" | $R variable set "$k" --stdin --service "$SVC" --skip-deploys >/dev/null && echo "  $k ✓" || die "could not set $k"
  else echo "  $k (not on the old one, skipped)"; fi
done

say_ "Deploying Get Transcript with its built-in transcriber (build ~3-5 min)"
printf builtin | $R variable set TRANSCRIBER_URL --stdin --service "$SVC" --skip-deploys >/dev/null || die "could not switch"
$R up --service "$SVC" --detach >/dev/null || die "deploy failed to start (the live server is unchanged)"
new=""
for i in $(seq 1 60); do
  sleep 10
  # this address only exists in the new version (old one answers with the web page)
  curl -s --max-time 10 "$SITE/transcriber/api/home-worker/status" | head -c 1 | grep -q '{' && { new=1; break; }
done
[ -n "$new" ] || die "the new version didn't come up in 10 min. Railway keeps the old version running if a build fails; Claude will check the logs."
echo "  new version is live ✓"

say_ "Live test: a spoken audio file through Get Transcript's own Whisper"
TMP=$(mktemp -d)
say -o "$TMP/t.aiff" "This is a live test of the Get Transcript server." && ~/.local/bin/ffmpeg -loglevel error -y -i "$TMP/t.aiff" "$TMP/t.m4a"
DEV=$(python3 -c 'import secrets;print(secrets.token_hex(16))')
ID=$(curl -s -X POST "$SITE/api/grab?deviceId=$DEV" -F "file=@$TMP/t.m4a" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
ok=""
for i in $(seq 1 30); do
  sleep 4
  J=$(curl -s "$SITE/api/grab/$ID?deviceId=$DEV")
  printf '%s' "$J" | python3 -c 'import sys,json;d=json.loads(sys.stdin.read(),strict=False);sys.exit(0 if d.get("status") in ("done","error") else 1)' 2>/dev/null || continue
  printf '%s' "$J" | python3 -c 'import sys,json;d=json.loads(sys.stdin.read(),strict=False);t=d.get("plain") or d.get("text") or "";print("  heard:",t[:80]);sys.exit(0 if "test" in t.lower() else 1)' && ok=1
  break
done
rm -rf "$TMP"
if [ -z "$ok" ]; then
  say_ "Test failed: pointing Get Transcript back at the old transcriber so nothing breaks"
  printf %s "$OLD_URL" | $R variable set TRANSCRIBER_URL --stdin --service "$SVC" >/dev/null && echo "  safe again ✓ (Claude will look at why)"
  exit 1
fi
echo "  transcript came back ✓"

say_ "Adding it to the home YouTube helper"
HW=~/.config/home-worker.env
if ! grep -q "pocket.99dfy.com/transcriber" "$HW"; then
  grep -v '^SERVERS=' "$HW" > "$HW.tmp"
  echo "SERVERS=https://video-processor-staging.up.railway.app,$OLD_URL,$SITE/transcriber" >> "$HW.tmp"
  mv "$HW.tmp" "$HW"; chmod 600 "$HW"
fi
pkill -f "^/usr/local/bin/node worker.js$" && echo "  helper restarted ✓" || echo "  (helper wasn't running)"

printf '\n✅ Done. Get Transcript is ONE server with its own transcriber, on its own OpenAI key.\n   The old shared transcriber keeps running for the other apps.\n'
