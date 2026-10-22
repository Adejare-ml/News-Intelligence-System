#!/usr/bin/env bash
# Triggers the Morning Brief email on production (auranews.pages.dev).
#
#   BRIEF_SEND_SECRET=... scripts/send_brief.sh [send|dry_run|test] [expected-edition]
#
# The sending itself happens in Cloudflare (web/functions/api/send-brief.ts),
# where the subscriber list lives; this only calls it. With an expected
# edition, it first waits (up to 10 minutes) until production serves that
# edition, so subscribers get the brief the site shows. Prints the result to
# the log and, in Actions, to the job summary.
set -uo pipefail

MODE="${1:-send}"
EXPECT="${2:-}"
SITE="${SITE_URL:-https://auranews.pages.dev}"

if [ -z "${BRIEF_SEND_SECRET:-}" ]; then
  echo "send-brief: BRIEF_SEND_SECRET is not set; email sending is not configured. Skipping."
  exit 0
fi

if [ -n "$EXPECT" ]; then
  for i in $(seq 1 20); do
    LIVE=$(curl -fsSL --max-time 30 "$SITE/brief/email/" 2>/dev/null | grep -o 'name="aura-edition" content="[^"]*"' | sed 's/.*content="//; s/"$//')
    [ "$LIVE" = "$EXPECT" ] && { echo "send-brief: production serves edition $EXPECT"; break; }
    echo "send-brief: waiting for production to serve $EXPECT (now: ${LIVE:-none})"; sleep 30
  done
  if [ "$LIVE" != "$EXPECT" ]; then
    echo "::error::Production never served edition $EXPECT; the brief was not sent."
    exit 1
  fi
fi

case "$MODE" in
  send) QUERY="" ;;
  dry_run) QUERY="?dry_run=1" ;;
  test) QUERY="?test=1" ;;
  *) echo "send-brief: unknown mode $MODE"; exit 2 ;;
esac

RESPONSE=$(curl -sS --max-time 120 -X POST -H "Authorization: Bearer $BRIEF_SEND_SECRET" \
  -w $'\n%{http_code}' "$SITE/api/send-brief$QUERY")
CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
echo "send-brief ($MODE): HTTP $CODE $BODY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Morning Brief email ($MODE)"; echo; echo "HTTP $CODE"; echo; echo '```json'; echo "$BODY"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
[ "$CODE" -lt 400 ] || { echo "::error::Morning Brief send returned HTTP $CODE"; exit 1; }
