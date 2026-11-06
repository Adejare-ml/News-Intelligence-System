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
has been deleted now that the Astro site is live. Only
`backend/app/static/data/` remains: the pipeline keeps writing its exports
there, and the site reads them at build time.

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
| `POST /api/subscribe` | Stores a Morning Brief sign-up (pending) in D1, with the reader's categories, region and frequency |
| `GET /api/confirm?token=` | Double opt-in confirmation |
| `GET/POST /api/preferences?token=` | The reader's own page: change categories, region, daily/weekly, or pause |
| `GET/POST /api/unsubscribe?token=` | One-click unsubscribe |
| `POST /api/send-brief` | Sends the morning email (owner secret; see below) |
| `GET /api/stats` | Subscriber counts by status, category, region and frequency, weekly sign-ups and recent sends. Needs `Authorization: Bearer <BRIEF_SEND_SECRET>`. Counts only, never addresses. |
| `GET /img?u=` | Serves publisher images from the site's origin, cached for a week. Only URLs in the build's `/img-allow.json` are fetched. |

### Morning Brief sign-ups (one-time setup)

Until this is done, the form says sign-ups open soon. Nothing breaks.

1. Create the database:
   **Workers & Pages → D1 → Create database**, name `aura`. Or, with
   wrangler: `npx wrangler d1 create aura`.
2. Create the tables: run each file in `web/migrations/` in order, e.g.
   `npx wrangler d1 execute aura --remote --file=web/migrations/0001_subscribers.sql`
   (or paste each file into the D1 console). `0003_preferences.sql` adds the
   reader's choices; existing subscribers keep business, Nigeria, daily.
3. Bind it to the site:
   **Pages project → Settings → Bindings → Add → D1 database**,
   variable name `DB`, database `aura`. Redeploy.

### Morning Brief email (Gmail, Brevo or Resend)

Sign-ups are stored as `pending` and nothing is sent until this is set up.
Once it is, new sign-ups get a confirmation email, and every morning after
the 08:00 Lagos run each confirmed subscriber gets that day's brief, with a
one-click unsubscribe link and header and a "Change topics" link.

What each reader gets depends on what they chose at sign-up:

- **Business** is the brief at `/brief/email/`.
- **Sports, Technology, Politics, Entertainment** are headline sections from
  `category_news.json` (`/brief/email/section/<category>/`), in the Nigeria
  edition, the Global one, or both. Readers without Business get them in the
  shell at `/brief/email/shell/`. Headlines older than 36 hours are left out.
- **Weekly** readers get the Monday email only.

Readers with the same choices share one copy, so each distinct email is
built once. Preview any mix with
`POST /api/send-brief?test=1&categories=business,sports&region=both`.

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
npx wrangler d1 execute aura --remote --file=web/migrations/0003_preferences.sql
```

**Apply 0003 before deploying the version with news categories**: the new
functions read the `categories`, `region`, `frequency` and `paused` columns.

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

Each email covers every story added since the last email that was **sent**.
After a send succeeds, the workflow commits `digests/last_edition.json`
(under `backend/app/static/data/`); a failed or skipped send leaves it, so
the next email keeps those stories. If the 08:00 run was missed or failed,
run **Actions → AI News Intelligence Scheduler** with *email_edition*
ticked: it rebuilds the edition (with its model-written overview),
publishes it and sends it.

Subscriber emails are personal data under the Nigeria Data Protection Act
2023: they are stored only in your D1 database, never leave Cloudflare,
are used only to send the brief, and stop receiving it on unsubscribe.

## Scheduler (starts the pipeline on time)

GitHub's own cron is unreliable for this repo: on 3 Nov 2026 it never
started the 07:11 UTC run, so the Morning Brief went out only after a manual
start, and other runs began 40+ minutes late. A small Cloudflare Worker,
`web/workers/scheduler`, now starts each run instead. Cloudflare cron
triggers fire on time.

- At :07 past 07, 13, 17 and 23 UTC it starts "AI News Intelligence
  Scheduler" through GitHub's API. The 07 UTC run is the Morning Brief
  edition (`email_edition=true`).
- At :40 it checks again and starts the run only if none has started for
  that slot, in case the first start failed.
- It never starts a second run for a slot. GitHub's own :11 cron and the
  watchdog stay as backups, and a scheduled run that arrives after the
  slot already ran skips itself (the `guard` job in `news_scheduler.yml`).

One-time setup:

1. **GitHub token.** On GitHub, go to Settings, then Developer settings, then
   Fine-grained tokens, then Generate new token.
   - Resource owner: your account. Repository access: only
     `News-Intelligence-System`.
   - Permissions: **Actions: Read and write**. Metadata (read) is added
     automatically. Nothing else is needed.
   - Pick a long expiry and note the date: the scheduler stops when the
     token expires.
2. **Worker.** In the Cloudflare dashboard, go to Workers & Pages, then
   Create, then Import a repository.
   - Choose this repository, branch `main`, and set the root directory to
     `web/workers/scheduler`.
   - Deploy. The name (`aura-scheduler`), the cron triggers and the
     variables come from its `wrangler.toml`.
3. **Secret.** In the Worker, go to Settings, then Variables and Secrets,
   then Add. Choose type Secret, name `GITHUB_TOKEN`, and paste the token.
4. **Check it.** In the Worker, go to Settings, then Trigger events. Both
   cron triggers should be listed. After the next slot, the Worker's logs
   show `{"action":"started",...}` and a `workflow_dispatch` run appears in
   GitHub Actions.

## Local development

```
cd web && npm ci && ./scripts/build-sites.sh
npx wrangler pages dev out/cloudflare --d1 DB=aura
```
