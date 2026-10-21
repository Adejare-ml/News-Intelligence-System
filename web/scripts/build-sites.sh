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
cp -r functions out/cloudflare/functions

AURA_BASE=/News-Intelligence-System/ AURA_SITE=https://adejare-ml.github.io npm run build
mv dist out/github
# _headers is Cloudflare-only.
rm -f out/github/_headers

# Keep GitHub Pages from running Jekyll over the _astro/ folder.
touch out/github/.nojekyll out/cloudflare/.nojekyll

echo "built: out/cloudflare ($(find out/cloudflare -name '*.html' | wc -l) pages), out/github"
