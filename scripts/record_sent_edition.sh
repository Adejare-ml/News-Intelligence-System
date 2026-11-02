#!/usr/bin/env bash
# After a Morning Brief send: record the edition that went out and commit
# the marker to main, so the next email starts where this one ended.
#
#   scripts/record_sent_edition.sh <send-result.json> <email_digest.json>
#
# Runs from the repository root of an Actions checkout whose token may push
# to main. A send that failed, was skipped, or used another edition records
# nothing (see record_sent_edition.py), and the next email keeps this one's
# stories. The commit carries [skip ci] and touches only digests/.
set -euo pipefail

RESULT="${1:?usage: record_sent_edition.sh <send-result.json> <email_digest.json>}"
DIGEST="${2:?usage: record_sent_edition.sh <send-result.json> <email_digest.json>}"

if [ ! -s "$RESULT" ]; then
  echo "record-sent: no send result; marker unchanged"
  exit 0
fi
if [ ! -s "$DIGEST" ]; then
  echo "::warning::record-sent: $DIGEST is missing; the next email repeats this one's stories."
  exit 0
fi
RESULT="$(realpath "$RESULT")"
DIGEST="$(realpath "$DIGEST")"
HERE="$(pwd)"
WORK="$(mktemp -d)"
trap 'cd "$HERE"; git worktree remove --force "$WORK" >/dev/null 2>&1 || true' EXIT

git fetch -q origin main
git worktree add -q --detach "$WORK" origin/main
python3 scripts/record_sent_edition.py "$RESULT" "$DIGEST" "$WORK/backend/app/static/data"

cd "$WORK"
git add backend/app/static/data/digests
if git diff --cached --quiet; then
  exit 0
fi
EDITION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edition"])' "$DIGEST")"
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "Record sent Morning Brief edition $EDITION [skip ci]"
for delay in 2 4 8 16; do
  if git push -q origin HEAD:main; then
    echo "record-sent: marker committed to main"
    exit 0
  fi
  echo "record-sent: push rejected; rebasing on main and retrying in ${delay}s"
  sleep "$delay"
  git fetch -q origin main
  git rebase -q origin/main
done
echo "::error::record-sent: could not push the marker; the next email will repeat edition $EDITION's stories."
exit 1
