# Hosting on Cloudflare Pages

The public site is the Astro project in `web/`. GitHub Actions builds it and
publishes ready-built copies to two branches:

| Branch             | Role        | Served by                             | Base path                    |
|--------------------|-------------|---------------------------------------|------------------------------|
| `gh-pages`         | **Testing** | GitHub Pages                          | `/News-Intelligence-System/` |
| `cloudflare-pages` | **Production** | Cloudflare Pages (auranews.pages.dev) | `/`                       |

## Testing and production

- **`main` is the testing branch.** Every push to it that touches `web/` or
  the data rebuilds only the GitHub Pages test site (`deploy_pages.yml`):
  https://adejare-ml.github.io/News-Intelligence-System/
- **Production changes only when you promote a version.** Check the test
  site, then run **Actions → Promote to production → Run workflow**
  (`promote_production.yml`). It builds the chosen commit (default: `main`)
  with the latest data, publishes it to `cloudflare-pages`, moves the
  `production` tag to that commit, and checks auranews.pages.dev serves it.
- **Data still refreshes production four times a day.** The scheduler's
  deploy job rebuilds the test site from `main` and production from the
  code at the `production` tag (`web/scripts/build-production.sh`), both
  with that run's data. Untested design changes on `main` never reach
  users through a data refresh.
- **Rolling back:** run the promote workflow with an older commit SHA.

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
