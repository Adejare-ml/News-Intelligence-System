#!/usr/bin/env bash
# Waits until production (auranews.pages.dev) serves the build of one commit.
#
#   scripts/wait_for_production.sh <full-commit-sha>
#
# web/scripts/build-production.sh writes the SHA of the code it built to
# /version.txt. That file is the one thing that tells a new build from the
# one before it: every page check also passes on the previous build. Cloudflare
# Pages deploys the cloudflare-pages branch some minutes after each push, so
# this polls (every 20 seconds for 10 minutes by default) and fails naming
# the expected and the served commit.
#
# SITE_URL, VERSION_ATTEMPTS and VERSION_INTERVAL (seconds) override the
# defaults; the tests point it at a local server.
set -uo pipefail

EXPECT="${1:-}"
SITE="${SITE_URL:-https://auranews.pages.dev}"
ATTEMPTS="${VERSION_ATTEMPTS:-30}"
INTERVAL="${VERSION_INTERVAL:-20}"

if ! [[ "$EXPECT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::wait-for-production: expected a full 40-character commit SHA, got '$EXPECT'."
  exit 2
fi

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
SERVED="nothing"
for i in $(seq 1 "$ATTEMPTS"); do
  : > "$BODY"
  # A new query string each time, so no cache on the way can answer with an
  # earlier copy of the file.
  CODE=$(curl -sSL --max-time 30 -H 'Cache-Control: no-cache' -o "$BODY" -w '%{http_code}' \
    "$SITE/version.txt?ts=$(date +%s)-$i" 2>/dev/null)
  LIVE=$(head -c 200 "$BODY" | tr -d '[:space:]')
  if [ "$CODE" = 200 ] && [[ "$LIVE" =~ ^[0-9a-f]{40}$ ]]; then
    SERVED="$LIVE"
  elif [ "$CODE" = 200 ]; then
    SERVED="a /version.txt that is not a commit SHA"
  elif [ -z "$CODE" ] || [ "$CODE" = 000 ]; then
    SERVED="no response"
  else
    SERVED="HTTP $CODE for /version.txt"
  fi

  if [ "$SERVED" = "$EXPECT" ]; then
    echo "OK production serves $EXPECT"
    exit 0
  fi
  echo "attempt $i/$ATTEMPTS: production serves $SERVED; waiting for $EXPECT"
  [ "$i" -lt "$ATTEMPTS" ] && sleep "$INTERVAL"
done

echo "::error::Production serves $SERVED, not the promoted commit $EXPECT, after ${SECONDS}s. Cloudflare has not deployed the promoted build: check Cloudflare -> auranews -> Deployments."
exit 1
