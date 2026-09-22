#!/usr/bin/env python3
"""Send the AURA morning briefing email from the just-exported data files.

Runs as a workflow step after the 07:00 UTC (08:00 Lagos) pipeline run,
when backend/app/static/data/* on the runner is this morning's output.
Owns all I/O and SMTP; the content itself is composed by
backend/app/services/briefing.py, which is pure and tested.

Configuration (GitHub secrets -> env):
  SMTP_USERNAME  the sending account (e.g. a Gmail address)
  SMTP_PASSWORD  its app password (Gmail: 2FA -> App passwords)
  MAIL_TO        recipient address
  SMTP_HOST      optional, default smtp.gmail.com
  SMTP_PORT      optional, default 587 (STARTTLS); 465 uses implicit TLS
  MAIL_FROM      optional, defaults to SMTP_USERNAME

Unconfigured (any of the three required vars missing) exits 0 with a log
line -- the briefing is opt-in and its absence must not look like a
pipeline failure. A real send failure exits 1 so the workflow step (which
runs with continue-on-error) shows red in the log without failing the run.
"""
import json
import os
import smtplib
import ssl
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend.app.services.briefing import (  # noqa: E402
    compose_briefing, report_stats_from_markdown)

DATA_DIR = REPO_ROOT / "backend" / "app" / "static" / "data"


def load_json(name):
    try:
        with open(DATA_DIR / name, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print(f"[briefing] {name} unavailable ({exc}); section will be empty.")
        return None


def load_text(name):
    try:
        with open(DATA_DIR / name, encoding="utf-8") as fh:
            return fh.read()
    except Exception as exc:
        print(f"[briefing] {name} unavailable ({exc}); section will be empty.")
        return ""


def main() -> int:
    username = os.environ.get("SMTP_USERNAME", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    mail_to = os.environ.get("MAIL_TO", "").strip()
    if not (username and password and mail_to):
        print("[briefing] SMTP_USERNAME / SMTP_PASSWORD / MAIL_TO not all set; "
              "morning email skipped (not configured).")
        return 0

    # `or` rather than get() defaults: the workflow passes these from
    # repository *vars*, which arrive as empty strings when unset.
    host = (os.environ.get("SMTP_HOST") or "smtp.gmail.com").strip()
    port = int(os.environ.get("SMTP_PORT") or 587)
    mail_from = os.environ.get("MAIL_FROM", "").strip() or username

    briefing = compose_briefing(
        weather=load_json("weather.json"),
        alerts_payload=load_json("alerts.json"),
        changes=load_json("changes.json"),
        report_stats=report_stats_from_markdown(load_text("report_latest.md")),
        now=datetime.now(),
    )

    message = MIMEMultipart("alternative")
    message["Subject"] = briefing["subject"]
    message["From"] = mail_from
    message["To"] = mail_to
    message.attach(MIMEText(briefing["text"], "plain", "utf-8"))
    message.attach(MIMEText(briefing["html"], "html", "utf-8"))

    context = ssl.create_default_context()
    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as server:
                server.login(username, password)
                server.sendmail(mail_from, [mail_to], message.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=30) as server:
                server.starttls(context=context)
                server.login(username, password)
                server.sendmail(mail_from, [mail_to], message.as_string())
    except Exception as exc:
        print(f"[briefing] send FAILED: {exc}")
        return 1

    print(f"[briefing] sent to {mail_to}: {briefing['subject']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
