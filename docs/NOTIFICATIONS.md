# Notifications: morning email + phone push

Both channels are **opt-in**: with no secrets configured the pipeline
behaves exactly as before. Neither can fail a pipeline run — delivery is
best-effort by design.

## Morning email briefing

One email after the 08:00 (Lagos) run: the weather, the run's summary
statistics, high-risk signals from the last 24 hours, and any register
changes (PSC added/moved/removed, new companies).

### Setup with Gmail

1. On the Google account that will **send** the mail, enable 2-step
   verification, then create an **App password**
   (myaccount.google.com → Security → 2-Step Verification → App passwords).
2. In the repo: **Settings → Secrets and variables → Actions → New
   repository secret**, add:

   | Secret | Value |
   |---|---|
   | `SMTP_USERNAME` | the Gmail address that sends |
   | `SMTP_PASSWORD` | the 16-character app password |
   | `MAIL_TO`       | where the briefing should arrive |

3. Done. The next 07:00 UTC scheduled run sends the first briefing.

Any other SMTP provider works too: set repository **variables**
`SMTP_HOST` and `SMTP_PORT` (587 = STARTTLS, 465 = implicit TLS);
optionally the secret `MAIL_FROM` if the sender should differ from
`SMTP_USERNAME`.

The composing logic lives in `backend/app/services/briefing.py` (pure,
tested in `tests/test_notifications.py`); delivery in
`scripts/send_morning_email.py`; the workflow step in
`news_scheduler.yml` is gated to the morning cron and runs with
`continue-on-error`, so a mail-provider outage never marks the pipeline
run red.

## Phone push alerts (ntfy)

Every run, each **new** high-risk record (risk High/Critical or score ≥ 70,
same banding as the dashboard) is pushed to your phone — capped at 5 per
run so a busy news day doesn't buzz you twenty times. Critical arrives as
an urgent-priority push; tapping it opens the article.

### Setup (free, no account)

1. Install the **ntfy** app (Android/iOS/F-Droid) or use ntfy.sh in a
   browser.
2. In the app, **subscribe to a topic** with a name nobody would guess —
   the topic name is the only access control, so treat it like a
   password, e.g. `aura-adejare-x7k2m9`.
3. Add a repository secret:

   | Secret | Value |
   |---|---|
   | `NTFY_TOPIC_URL` | `https://ntfy.sh/aura-adejare-x7k2m9` |

4. Done. The next run with a fresh high-risk record pushes it.

The payload builder is `ntfy_payloads()` in
`backend/app/services/feeds.py`, next to the existing generic
`ALERT_WEBHOOK_URL` Slack/Discord-style webhook — both can be active at
once.
