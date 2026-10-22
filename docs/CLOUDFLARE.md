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

### Morning Brief email (Gmail, Brevo or Resend)

Sign-ups are stored as `pending` and nothing is sent until this is set up.
Once it is, new sign-ups get a confirmation email, and every morning after
the 08:00 Lagos run each confirmed subscriber gets that day's brief (the
email at `/brief/email/`), with a one-click unsubscribe link and header.

How it works: the subscriber list stays in D1. The scheduler waits until
production shows the new edition, then calls `POST /api/send-brief` with a
shared secret; Cloudflare sends through Gmail, Brevo or Resend. One send per
Lagos day, and an edition that was already sent is never sent again.

**1. Pick a provider.**

- **Gmail, no domain and no new account** (about 500 a day). Turn on
  2-Step Verification for the Google account, then create an **App
  Password** at myaccount.google.com/apppasswords (name it "AURA"). Emails
  come from your own Gmail address with the name "AURA Morning Brief".
  Cloudflare connects to `smtp.gmail.com:465` over TLS, one session per
  morning. AURA stops at 450 a day to stay under Gmail's limit; a personal
  account that mails a large list can land in spam, so move to a domain
  with Resend as the list grows.
- **Brevo, no domain needed** (free: 300 emails a day). brevo.com → sign
  up → Settings → Senders, domains & IPs → **Senders → Add a sender** with
  the address you want replies to go to (a Gmail address works) and
  confirm it. Then **SMTP & API → API Keys → Generate a new API key**.
  Without a domain of your own, Brevo sends from its own domain
  (`…@brevosend.com`) but shows your sender name.
- **Resend, with a domain you own** (free: 100 a day, 3,000 a month).
  resend.com → Domains → Add domain; use a subdomain such as
  `mail.yourdomain.com` and add the DNS records Resend lists (SPF and MX on
  `send.…`, a DKIM TXT on `resend._domainkey.…`), then wait for
  **Verified**. Then **API Keys → Create** (sending access).

**2. Create the database tables** (once):

```
npx wrangler d1 create aura                 # if it doesn't exist yet
npx wrangler d1 execute aura --remote --file=web/migrations/0001_subscribers.sql
npx wrangler d1 execute aura --remote --file=web/migrations/0002_sends.sql
```

(or paste each file into the D1 console). Then **Pages project → Settings
→ Bindings → Add → D1 database**: variable `DB`, database `aura`.

**3. Pages environment variables** (Settings → Variables and Secrets,
Production):

| Variable | Value |
|---|---|
| `EMAIL_PROVIDER` | `gmail`, `brevo` or `resend` |
| `GMAIL_USER` | your Gmail address (Gmail only) |
| `GMAIL_APP_PASSWORD` | the 16-letter App Password (**Secret**; Gmail only) |
| `BREVO_API_KEY` | the Brevo API key (**Secret**; Brevo only) |
| `RESEND_API_KEY` | the Resend API key (**Secret**; Resend only) |
| `MAIL_FROM` | `AURA Morning Brief <the sender you verified>` (optional for Gmail) |
| `SITE_URL` | `https://auranews.pages.dev` |
| `BRIEF_SEND_SECRET` | a long random string (**Secret**), e.g. `openssl rand -hex 32` |
| `OWNER_EMAIL` | your address, for test sends |

**4. GitHub secret:** repository → Settings → Secrets and variables →
Actions → `BRIEF_SEND_SECRET`, the same value as in step 3.

**5. Ship it:** run **Actions → Promote to production** so the new
function is live, then **Actions → Send Morning Brief**:

- `dry_run`: how many confirmed subscribers would get today's brief;
- `test`: one copy to `OWNER_EMAIL`, to check it in your inbox;
- `send`: send today's brief now (never twice in one day).

From then on the 08:00 Lagos run sends it automatically; the result is in
that run's job summary.

Subscriber emails are personal data under the Nigeria Data Protection Act
2023: they are stored only in your D1 database, never leave Cloudflare,
are used only to send the brief, and stop receiving it on unsubscribe.

## Local development

```
cd web && npm ci && ./scripts/build-sites.sh
npx wrangler pages dev out/cloudflare --d1 DB=aura
```
