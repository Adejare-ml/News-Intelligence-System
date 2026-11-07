# Ownership Finding of the Week

One finding a week, picked and hand-checked by the owner, for readers to share. Nothing is posted automatically.

## The routine

1. **Pick.** Add an entry to [`backend/app/static/data/findings/picks.json`](../backend/app/static/data/findings/picks.json) on `main`: `{"week": "2026-W45", "entity": "tony-elumelu", "headline": "...", "note": "..."}`. `week` is the ISO week (`YYYY-Www`); the newest one is drafted. Give either `entity` (the slug of an `/entity/<slug>/` page) or `record_ref` (one holding, `person-slug/company-slug`). `note` is optional context.
2. **Draft.** Run **Actions → Draft finding of the week** (or `python scripts/draft_finding.py`). It writes `findings/<week>.json`: 2–3 bullets, each with outlet, link and date, plus template LinkedIn (≤ 1,300 chars), X (≤ 280) and journalist-email drafts ending with the finding's link. The workflow commits it to branch `finding/<week>` and prints the drafts in the run summary.
3. **Check by hand.** Open every source and confirm each bullet; edit the JSON on the branch if needed. Leave each register bullet's `record` (the row's person and company keys) as it is: the build uses it to find that exact row again.
4. **Publish.** Merge the branch: the next build adds `/findings/<week>/` and a home page link. Post the drafts yourself.

## When the script refuses

It exits 1 and writes no file when:

- the pick has no published register row or article behind it (unsourced or quarantined rows never count);
- a `record_ref` holding has no published row;
- the `entity` is a company that only withheld register rows name (the site would drop the finding without saying why);
- the entity, headline or note names a person with no published register row;
- the `entity` is neither a published register person nor a company the register or the appointments feed names (it could be a person the register does not back);
- fewer than two facts can be cited.

`procurement.json` rows carry no article link, so they are not used.

## What the build rechecks

Each build checks merged findings against today's register and leaves out any that no longer stand: a register bullet must still match its own published row (same link, person key and company key, so another row citing the same article does not keep it alive), and the finding must not name, in any spelling, a person or company that only withheld rows name.

## Search engines

A finding that may name a person carries `noindex` and stays out of the sitemap, like the register. The script marks it so (`names_person`) whenever it has a register bullet, the headline, note or bullets name a person AURA knows, or a cited article is tagged with anything it cannot tell is a company. Only a finding it is sure names no one is indexed.

## Writing a good one

**A good finding** is one clear fact about control (who holds what, through what), backed by two or more reports, that readers would not already know, worded as reported ("is reported to hold"), not as a filing.

**Never name a person without the register's evidence.** Only people named by a published register row may appear. The script catches names AURA has seen, so check the wording yourself.
