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

## Security headers

`web/public/_headers` sets a strict Content-Security-Policy on every page:
scripts only from the site itself (the build emits no inline scripts),
images only from the site (publisher images go through `/img`), no
framing. It also sets HSTS, `nosniff`, and long caching for fingerprinted
`/_astro/*` files.

## Functions

`web/functions/` is copied into the `cloudflare-pages` branch, and Pages
deploys it with the site:

| Route | What it does |
|---|---|
| `POST /api/subscribe` | Stores a Morning Brief sign-up (pending) in D1 |
| `GET /api/confirm?token=` | Double opt-in confirmation |
| `GET/POST /api/unsubscribe?token=` | One-click unsubscribe |
| `GET /img?u=` | Serves publisher images from the site's origin, cached for a week. Only URLs in the build's `/img-allow.json` are fetched. |

### Morning Brief sign-ups (one-time setup)

Until this is done, the form says sign-ups open soon. Nothing breaks.

1. Create the database:
   **Workers & Pages → D1 → Create database**, name `aura`. Or, with
   wrangler: `npx wrangler d1 create aura`.
2. Create the table:
   `npx wrangler d1 execute aura --remote --file=web/migrations/0001_subscribers.sql`
   (or paste the file into the D1 console).
3. Bind it to the site:
   **Pages project → Settings → Bindings → Add → D1 database**,
   variable name `DB`, database `aura`. Redeploy.

### Sending (off by default)

Sign-ups are stored as `pending` and no email is sent until you add these
**environment variables** to the Pages project (Settings → Variables and
Secrets):

| Variable | Value |
|---|---|
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | an API key from resend.com (store as a secret) |
| `MAIL_FROM` | e.g. `AURA <brief@yourdomain.com>`, on a domain verified in Resend |
| `SITE_URL` | `https://auranews.pages.dev` |

With these set, new sign-ups get a confirmation email. The daily brief's
email layout is previewed at `/brief/email/`.

Subscriber emails are personal data under the Nigeria Data Protection Act
2023: they are stored only in your D1 database, used only to send the
brief, and removed from the sending list on unsubscribe.

## Local development

```
cd web && npm ci && ./scripts/build-sites.sh
npx wrangler pages dev out/cloudflare --d1 DB=aura
```
