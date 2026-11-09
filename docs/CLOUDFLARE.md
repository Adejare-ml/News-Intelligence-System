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
  `production` tag to that commit, and checks auranews.pages.dev serves it:
  the smoke test waits up to 10 minutes for
  `https://auranews.pages.dev/version.txt` to show the promoted commit's
  SHA, and fails if Cloudflare is still serving the previous build. Data
  refreshes write the same SHA (the commit the `production` tag names), so
  the file keeps naming the promoted code between promotions.
- **Data still refreshes production four times a day.** The scheduler's
  deploy jobs rebuild the test site from `main` and production from the
  code at the `production` tag (`web/scripts/build-production.sh`), both
  with that run's data. Untested design changes on `main` never reach
  users through a data refresh. The production half (`deploy-production`)
  shares the promote workflow's `production-deploy` concurrency group, so
  a refresh and a promotion never overlap: a refresh that starts during a
  promotion waits for it and builds the newly promoted code, and so cannot
  put the previous code back.
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

The Functions' own pages and JSON (sign-up links, preferences) set theirs
in `web/functions/_lib/http.ts`: a CSP that allows only inline styles and
forms that post back to the site, HSTS, `nosniff`, and
`Referrer-Policy: no-referrer`, so a link's token never leaks to another
site.

## Functions

`web/functions/` is copied into the `cloudflare-pages` branch, and Pages
deploys it with the site:

| Route | What it does |
|---|---|
| `POST /api/subscribe` | Stores a Morning Brief sign-up (pending) in D1, with the reader's categories, region and frequency (limits below) |
| `GET/POST /api/confirm?token=` | Double opt-in. GET shows a "Confirm" button; only its POST confirms |
| `GET/POST /api/preferences?token=` | The reader's own page: change categories, region, daily/weekly, or pause |
| `GET/POST /api/unsubscribe?token=` | GET shows an "Unsubscribe" button; POST unsubscribes, including mail clients' one-click (RFC 8058) |
| `POST /api/send-brief` | Sends the morning email, then does the sign-up housekeeping (owner secret; see below) |
| `GET /api/stats` | Subscriber counts by status, category, region and frequency, weekly sign-ups, confirmation rate and median hours to confirm, and recent sends. Needs `Authorization: Bearer <BRIEF_SEND_SECRET>`. Counts only, never addresses. |
| `POST /api/dispute` | Right of reply: stores a dispute about a record in D1 (`disputes`) and emails `OWNER_EMAIL` when sending is on. Five per sender a day. |
| `POST/GET /api/hit` | Cookieless reader counts: one per page view (sent by the site's hit script) or email click (`GET ?to=<this site's URL>&s=<source>`, then a 302). Stores only a daily count per path and source; skips bots and Do Not Track / Global Privacy Control. Needs migration `0006_hits.sql`. |
| `GET /api/stats/traffic` | Last 30 days: page views per day, top pages, and clicks per Morning Brief edition beside its send count. Owner secret, like `/api/stats`. |
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
   `0004_mail_throttle.sql` adds the sign-up mail limits.
3. Bind it to the site:
   **Pages project → Settings → Bindings → Add → D1 database**,
   variable name `DB`, database `aura`. Redeploy.

### Disputes (one-time setup)

The `/dispute/` form needs the `disputes` and `dispute_throttle` tables.
Until they exist, posting the form fails, so apply this before (or with)
the deploy that ships the form:

```
npx wrangler d1 execute aura --remote --file=web/migrations/0005_disputes.sql
```

It also needs a `DISPUTE_SECRET` (**Secret**, Production) in the Pages
project's environment variables: a long random string, e.g.
`openssl rand -hex 32`. It keys the per-sender daily limit, so the stored
codes cannot be turned back into IP addresses. Until it is set, the form
says it opens soon and stores nothing.

New disputes arrive with status `open`. Read them in the D1 console
(`SELECT * FROM disputes WHERE status = 'open' ORDER BY id`), reply by
email, then mark them done (`UPDATE disputes SET status = 'resolved' WHERE id = ?`).
How to correct or unpublish a record is in [CORRECTIONS.md](CORRECTIONS.md).

### Morning Brief email (Gmail, Brevo or Resend)

Sign-ups are stored as `pending` and nothing is sent until this is set up.
Once it is, new sign-ups get a confirmation email, and every morning after
the 08:00 Lagos run each confirmed subscriber gets that day's brief, with a
one-click unsubscribe link and header and a "Change topics" link.

What each reader gets depends on what they chose at sign-up:

- **Business** is the brief at `/brief/email/`.
- **Technology, Politics** are headline sections from
  `category_news.json` (`/brief/email/section/<category>/`), in the Nigeria
  edition, the Global one, or both. Readers without Business get them in the
  shell at `/brief/email/shell/`. Headlines older than 36 hours are left out,
  and so is a category with no headlines in the reader's regions.
- **Weekly** readers get the Monday email only. If they chose Business, it
  carries the week in business (the Sunday weekly wrap,
  `/brief/email/section/business-week/`) instead of Monday's daily brief;
  if the wrap is more than 48 hours old, they get Monday's brief.

Readers with the same choices share one copy, so each distinct email is
built once, and all copies go out in one pass: one Gmail session under one
daily cap, or shared Resend/Brevo batches. Preview any mix with
`POST /api/send-brief?test=1&categories=business,technology&region=both`
(add `&frequency=weekly` to preview the weekly email).

How it works: the subscriber list stays in D1. The scheduler waits until
production shows the new edition, then calls `POST /api/send-brief` with a
shared secret; Cloudflare sends through Gmail, Brevo or Resend. One send per
Lagos day, and an edition that was already sent is never sent again.

Sports and Entertainment were offered until November 2026 and have been
cut. Readers who chose them keep their other topics; one who chose only
those now gets Business.

**Sign-up limits.** So the form cannot be used to flood someone's inbox or
use up the provider's daily quota:

- An address gets at most **one sign-up mail per 10 minutes** and **three
  per Lagos day** (confirmation and already-subscribed mails alike). Past
  that the form answers exactly as usual but sends nothing, so it never
  reveals whether an address is on the list.
- One IP address (`CF-Connecting-IP`) may post **20 sign-ups per Lagos
  day**; after that it gets "Too many sign-ups from here today."
- If the provider refuses a mail, the reader is told to try again in a few
  minutes, and that try does not count against the address.
- Confirmation and unsubscribe links do nothing until the button on the
  page is pressed, so mail scanners that open every link change nothing.
- The **"Get updates by email" form** on company pages (`/api/follow`)
  sends mail too, so it has the same limits. An address gets at most one
  follow email per 10 minutes and three per Lagos day: an address on the
  list shares its three with the sign-up mails above, and any other address
  is counted in `throttle` under `follow:<SHA-256 of the address>`, never
  the address itself. Past that the form answers as usual but sends
  nothing. Its posts count against the same **20 per IP per Lagos day** as
  sign-ups (one budget for both forms), after which it gets "Too many
  requests from here today." Together these keep a script from flooding one
  inbox or spending the provider's daily quota before the Morning Brief.

**Housekeeping** runs after each day's real send, and also on a real call
that finds nobody to send to (`nothing_to_send` or `edition_already_sent`:
launch day with no confirmed readers, or Tuesday to Sunday when every reader
is weekly): pending sign-ups not mailed for 30 days are deleted, pending
sign-ups 48-72 hours old that have had only their first mail get one
reminder (at most 20 a run, within the limits above; on Gmail, only from
what the brief left of the 450 a day), and earlier days' counts in
`throttle` (IP addresses, hashed follow-form addresses) are deleted. A
retry the same day reminds nobody twice. The send's JSON result reports
the counts under `housekeeping`.

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
npx wrangler d1 execute aura --remote --file=web/migrations/0004_mail_throttle.sql
npx wrangler d1 execute aura --remote --file=web/migrations/0006_hits.sql
```

**Apply 0003 before deploying the version with news categories**: the new
functions read the `categories`, `region`, `frequency` and `paused` columns.
**Apply 0004 before deploying the version with sign-up limits**: sign-ups
read and write `last_mailed_at`, `mail_day`, `mails_today` and the
`throttle` table, and fail without them.

**Apply 0007 before deploying Follow by email**
(`npx wrangler d1 execute aura --remote --file=web/migrations/0007_follows.sql`).
It adds `follows` (the companies each reader follows, by token, at most 20)
and `follow_requests` (throttles the "Get updates by email" form on company
pages to one email per address every 10 minutes; rows older than a day are
deleted). Without it the follow form and follow buttons fail, the
preferences page shows topics only, and the brief goes out with no Following block (its send report says
`following.error`). It only creates new tables, so it is safe to apply at
any time, before or after 0004 to 0006. The follow form's daily limits
(three emails per address, 20 posts per IP; see **Sign-up limits** above)
need no table of their own: they use 0004's mail columns and `throttle`
table, so the form needs 0004 applied as well.

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
| `OWNER_EMAIL` | your address, for test sends and new disputes (and for replies, if `REPLY_TO` is unset) |
| `REPLY_TO` | where readers' replies go, e.g. `AURA <you@example.com>` (optional; defaults to `OWNER_EMAIL`) |

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
  watchdog stay as backups. A scheduled run skips itself only when another
  run that did real work (queued, running, or longer than two minutes)
  started in the last 150 minutes, or when the Worker, the watchdog or a
  person already ran its slot (`scripts/scheduler_guard.py`, used by the
  `guard` job in `news_scheduler.yml`). So the late `11 7` cron does not
  send a second morning email. Runs that skipped themselves never count,
  and neither does another late cron, so one late run cannot make the rest
  of the day skip.
- If no run does real work for six hours, the watchdog opens one issue
  labelled `pipeline-missed` (later checks comment on it). The next run
  that completes and publishes the site closes it, and any open
  `pipeline-failure` issue.

Until the Worker is deployed, every run comes from GitHub's cron, hours
late, and the Morning Brief goes out in the afternoon.

One-time setup (the "Deploy scheduler Worker" workflow does the deploy;
you create three tokens and store them as repository secrets):

1. **Cloudflare API token.** In the Cloudflare dashboard, open your
   profile (top right), then API Tokens, then Create Token.
   - Use the **Edit Cloudflare Workers** template, or Create Custom Token
     with the permission **Account, Workers Scripts, Edit**.
   - Account Resources: Include, your account. Zone Resources: none
     needed (the Worker uses only `workers.dev` and cron triggers).
   - Create the token and copy it; Cloudflare shows it once.
2. **Cloudflare account ID.** In the dashboard, go to Workers & Pages.
   The Account ID is in the right-hand column of the Overview page (or
   on any domain's Overview page, under API). Copy it.
3. **GitHub token for the Worker.** On GitHub, go to Settings, then
   Developer settings, then Personal access tokens, then Fine-grained
   tokens, then Generate new token.
   - Resource owner: your account. Repository access: Only select
     repositories, `News-Intelligence-System`.
   - Repository permissions: **Actions: Read and write**. Metadata (read)
     is added automatically. Nothing else is needed.
   - Pick a long expiry and note the date: the scheduler stops when the
     token expires (the `pipeline-missed` issue is how you will notice).
4. **Repository secrets.** In this repository, go to Settings, then
   Secrets and variables, then Actions, then New repository secret, and
   add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 2.
   - `SCHEDULER_GITHUB_TOKEN`: the token from step 3.
5. **Deploy.** Go to Actions, then **Deploy scheduler Worker**, then Run
   workflow (branch `main`). It deploys `aura-scheduler` with the cron
   triggers and variables from `web/workers/scheduler/wrangler.toml`, then
   stores the GitHub token as the Worker's `GITHUB_TOKEN` secret. If a
   secret is missing, the run ends with a notice naming it. Later changes
   under `web/workers/scheduler/` redeploy on push to `main`; after
   renewing the GitHub token, update `SCHEDULER_GITHUB_TOKEN` and run the
   workflow again.
6. **Check it.** In the Cloudflare dashboard, open Workers & Pages, then
   `aura-scheduler`, then Settings, then Trigger events. Both cron
   triggers should be listed. After the next slot, the Worker's logs show
   `{"action":"started",...}` and a `workflow_dispatch` run appears in
   GitHub Actions at :07.

## Local development

```
cd web && npm ci && ./scripts/build-sites.sh
npx wrangler pages dev out/cloudflare --d1 DB=aura
```
