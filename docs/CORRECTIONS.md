# Disputes, corrections and unpublishing

AURA names people and companies from news reports, so it needs a way for
them to answer back, and a public record of what was fixed.

## 1. A dispute comes in

Readers use **Dispute this record** (on entity pages and every holding
card), which opens `/dispute/?ref=<record>`. The form posts to
`/api/dispute`, which stores the dispute in D1 (`disputes`, status
`open`) and emails `OWNER_EMAIL` when email sending is on. Setup is in
[CLOUDFLARE.md](CLOUDFLARE.md#disputes-one-time-setup).

Check the record against its source article, reply to the sender, then
do one of the two things below, or nothing if the record stands.

## 2. Correct a record

Fix the row in the Google Sheet, then add an entry to
`backend/app/static/data/corrections.json`. The site lists it on
`/corrections/` at the next build. The file is a JSON list, in any
order (the page shows the newest first):

```json
[
  {
    "date": "2026-11-07",
    "ref": "Ikeja Mills Plc / holder record",
    "what_changed": "Stake corrected from 60% to 6%.",
    "reason": "The source article said 6%; the figure was misread."
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `date` | yes | When the change was made, `YYYY-MM-DD` |
| `ref` | no | Which record or page. Leave out names that were unpublished |
| `what_changed` | yes | What is different now, in one or two plain sentences |
| `reason` | no | Why it changed |

Entries without a `date` or `what_changed` are skipped. An entry that
names someone on the unpublished list is not shown either.

## 3. Unpublish a name

```
python3 scripts/unpublish.py "Full Name or Company Ltd" --reason "dispute upheld" [--kind person|company]
```

This appends `{name, kind?, added, reason}` to
`backend/app/static/data/suppressed.json`. Commit and push it:

- the next **site build** stops showing the name anywhere: entity pages,
  the register, news, the brief, search (`search-index.json`), the
  sitemap and the email page;
- the next **pipeline run** drops every row naming it from the exported
  files (`significant_control.json`, `people.json`, `companies.json`,
  `latest.json`, `graph.json`, `alerts.json`, the timelines and the email
  digest). The rows stay in the Google Sheet.

Matching is by whole words, ignoring case: "Aliko Dangote" also hides
"Alhaji Aliko Dangote", but not "Dangote Cement". Use the full name; a
single common word would hide every record containing it. Any article,
brief line or contract that names the entity is hidden with it.

To publish a name again, delete its entry from `suppressed.json`.

Until the next pipeline run, the raw files under `/data/` (copied from
the last export) can still contain the name; trigger a run to clear them
at once.
