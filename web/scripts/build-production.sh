#!/usr/bin/env bash
# Build the production (Cloudflare) copy from the PROMOTED site code with the
# CURRENT data.
#
#   bash web/scripts/build-production.sh <git-ref>     # run from the repo root
#
# main is the testing branch: every push rebuilds only the GitHub Pages test
# site. Production code moves only when someone promotes a version (the
# "Promote to production" workflow, which moves the `production` tag). The
# pipeline's data still refreshes production four times a day, so this
# script takes web/ from <git-ref> and the data, evals and tests from the
# checkout it runs in. Output: ./out-production (ready for cloudflare-pages).
set -euo pipefail

REF="${1:?usage: build-production.sh <git-ref>}"
ROOT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git archive "$REF" web | tar -x -C "$WORK"
# The site reads the pipeline's exports (and, on How it works, the eval set
# and test counts) from the repository around web/.
for dir in backend evals tests; do
  [ -e "$ROOT/$dir" ] && ln -s "$ROOT/$dir" "$WORK/$dir"
done
# Reuse logos already fetched in this job (or restored from the cache).
if [ -d "$ROOT/web/public/logos" ]; then
  mkdir -p "$WORK/web/public"
  cp -r "$ROOT/web/public/logos" "$WORK/web/public/logos"
fi

cd "$WORK/web"
npm ci --no-audit --no-fund
SITES=cloudflare bash scripts/build-sites.sh

rm -rf "$ROOT/out-production"
mv out/cloudflare "$ROOT/out-production"
echo "build-production: $(git -C "$ROOT" rev-parse --short "$REF") code + current data -> out-production"
