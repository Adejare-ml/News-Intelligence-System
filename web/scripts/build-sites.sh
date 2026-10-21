#!/usr/bin/env bash
# Build the two published copies of the site from the same commit:
#   web/out/cloudflare  served from the domain root (auranews.pages.dev)
#   web/out/github      served from /News-Intelligence-System/ (GitHub Pages mirror)
# Asset URLs differ by base path, so one build cannot serve both.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf out
mkdir -p out

AURA_BASE=/ AURA_SITE=https://auranews.pages.dev PUBLIC_IMG_PROXY=1 npm run build
mv dist out/cloudflare
# Pages Functions (/api/*, /img) deploy from the branch root's functions/ dir.
# Cloudflare compiles every file under functions/ into the Worker, so the
# unit tests must not ship: they import node:test, which does not bundle,
# and one failed Functions build leaves the whole domain without a live
# deployment (every URL 404s).
cp -r functions out/cloudflare/functions
find out/cloudflare/functions -name '*.test.*' -delete
if find out/cloudflare/functions -name '*.test.*' | grep -q . \
   || grep -rqE "from ['\"]node:(test|assert)" out/cloudflare/functions; then
  echo "build-sites: test code would ship to Cloudflare Functions" >&2
  exit 1
fi

AURA_BASE=/News-Intelligence-System/ AURA_SITE=https://adejare-ml.github.io npm run build
mv dist out/github
# _headers is Cloudflare-only.
rm -f out/github/_headers

# Keep GitHub Pages from running Jekyll over the _astro/ folder.
touch out/github/.nojekyll out/cloudflare/.nojekyll

echo "built: out/cloudflare ($(find out/cloudflare -name '*.html' | wc -l) pages), out/github"
