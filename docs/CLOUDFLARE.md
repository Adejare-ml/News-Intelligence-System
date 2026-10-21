# Hosting on Cloudflare Pages

The public site is the Astro project in `web/`. GitHub Actions builds it and
publishes ready-built copies to two branches:

| Branch             | Served by                      | Base path                   |
|--------------------|--------------------------------|-----------------------------|
| `cloudflare-pages` | Cloudflare Pages (auranews.pages.dev) | `/`                  |
| `gh-pages`         | GitHub Pages mirror            | `/News-Intelligence-System/` |

Both are rebuilt after every pipeline run (`news_scheduler.yml`, deploy job)
and on any push to `main` that touches `web/` or the data
(`deploy_pages.yml`).

## Why Cloudflare does not build the site itself

The pipeline commits fresh data four times a day with `[skip ci]` in the
message. Cloudflare's Git integration skips commits marked that way, so a
Cloudflare build from `main` would never pick up new data. Building in
Actions and handing Cloudflare a finished branch avoids that and keeps one
build pipeline.

## One-time switch-over

In the Cloudflare dashboard, open **Workers & Pages → (your AURA project) →
Settings → Build**:

1. **Production branch:** `cloudflare-pages`
2. **Build command:** leave empty
3. **Build output directory:** `/`
4. **Root directory:** leave empty

Then go to **Deployments** and choose **Retry deployment** (or wait for the
next pipeline run). The `cloudflare-pages` branch appears after this PR's
deploy workflow first runs on `main`. If you would rather not wait, run
**Actions → Deploy site → Run workflow** once.

### Check it worked

- `https://auranews.pages.dev/` shows "Who really controls Nigeria's companies?"
  with the gold-on-navy globe.
- `https://auranews.pages.dev/register/` lists holdings, one card per holder
  and company.
- `https://auranews.pages.dev/data/latest.json` still serves the raw export.

## Removing the old dashboard

The old vanilla-JS dashboard (`backend/app/static/index.html`, `css/`, `js/`)
stays in the repository until the switch-over above is confirmed, because the
current Cloudflare project may still be serving it. Once the new site is
live, a follow-up PR deletes it. The pipeline keeps writing its exports to
`backend/app/static/data/`, which the new site reads at build time.

## Later PRs

- **Response headers** (`web/public/_headers`): security headers and caching.
- **Pages Functions** (`/api/subscribe` for the Morning Brief, `/img` for
  publisher images): these need a D1 database binding, added in the
  Cloudflare dashboard. Steps will be added here with that PR.
