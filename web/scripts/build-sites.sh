#!/usr/bin/env bash
# Build the published copies of the site:
#   web/out/cloudflare  production, served from the domain root (auranews.pages.dev)
#   web/out/github      the test site, under /News-Intelligence-System/ (GitHub Pages)
# Asset URLs differ by base path, so one build cannot serve both.
#
# SITES=both (default) | cloudflare | github picks which copies to build.
set -euo pipefail
cd "$(dirname "$0")/.."

SITES="${SITES:-both}"
rm -rf out
mkdir -p out

# Organisation logos for story and entity banners (best effort, cached).
node scripts/fetch-logos.mjs || echo "fetch-logos: skipped"

if [ "$SITES" = "both" ] || [ "$SITES" = "cloudflare" ]; then
  AURA_BASE=/ AURA_SITE=https://auranews.pages.dev PUBLIC_IMG_PROXY=1 npm run build
  mv dist out/cloudflare
  # Pages Functions (/api/*, /img) deploy from the branch root's functions/ dir.
  # Cloudflare compiles every file under functions/, so unit tests stay out.
  cp -r functions out/cloudflare/functions
  find out/cloudflare/functions -name '*.test.*' -delete
  if find out/cloudflare/functions -name '*.test.*' | grep -q . \
     || grep -rqE "from ['\"]node:(test|assert)" out/cloudflare/functions; then
    echo "build-sites: test code would ship to Cloudflare Functions" >&2
    exit 1
  fi
  touch out/cloudflare/.nojekyll
fi

if [ "$SITES" = "both" ] || [ "$SITES" = "github" ]; then
  AURA_BASE=/News-Intelligence-System/ AURA_SITE=https://adejare-ml.github.io npm run build
  mv dist out/github
  # _headers is Cloudflare-only.
  rm -f out/github/_headers
  # Keep GitHub Pages from running Jekyll over the _astro/ folder.
  touch out/github/.nojekyll
fi

echo "built ($SITES):$( [ -d out/cloudflare ] && echo " out/cloudflare ($(find out/cloudflare -name '*.html' | wc -l) pages)")$( [ -d out/github ] && echo " out/github")"
