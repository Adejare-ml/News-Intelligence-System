#!/usr/bin/env python3
"""
Draft the Ownership Finding of the Week from the owner's latest pick.

The owner names one record or entity a week in findings/picks.json. This
script gathers what the site already publishes about it and writes
findings/<week>.json: the headline, 2-3 sourced bullet points, and draft
LinkedIn, X and journalist-email text built from fixed templates. Nothing is
posted anywhere; the owner reads the draft, edits it if needed, and merges it.

It reads only rows the site may publish: register rows that pass the same
gate as web/src/lib/psc.ts (a source link, not quarantined) and articles from
latest.json, without anything naming an entity the owner unpublished
(suppressed.json, as the site leaves those out). procurement.json rows carry
no article link, so they cannot back a sourced bullet and are not used. If the
pick has nothing published behind it, names an unpublished entity, or would
name a person the register does not back, it refuses (exit 1) rather than
write a draft.

    python scripts/draft_finding.py [--data-dir DIR] [--site URL]
"""
import argparse
import json
import os
import re
import sys
import unicodedata

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, REPO)

from backend.app.services import suppression  # noqa: E402

DEFAULT_DATA = os.path.join(REPO, "backend", "app", "static", "data")
DEFAULT_SITE = "https://auranews.pages.dev"
WEEK = re.compile(r"^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$")
LINKEDIN_MAX = 1300
X_MAX = 280
MAX_BULLETS = 3
MIN_BULLETS = 2


class Refusal(Exception):
    """The pick cannot become a finding; the message says why."""


def slugify(value):
    """Same slug as web/src/lib/entity-key.ts, so picks use the site's entity URLs."""
    s = re.sub(r"\s+", " ", str(value or "").replace(" ", " ").strip()).lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def is_public(row):
    """The register's publishing gate, mirrored from isPublic() in web/src/lib/psc.ts."""
    if str(row.get("Quarantined", "")).lower() == "true":
        return False
    return bool(re.match(r"^https?://", str(row.get("Source URL") or "").strip()))


def mentions(text, slug):
    """Whole-word match of a name (as a slug) inside free text."""
    return bool(slug) and f"-{slug}-" in f"-{slugify(text)}-"


def latest_pick(picks):
    for p in picks:
        if not WEEK.match(str(p.get("week", ""))):
            raise Refusal(f"pick week {p.get('week')!r} is not an ISO week like YYYY-Www (e.g. 2026-W45)")
    if not picks:
        raise Refusal("findings/picks.json has no picks")
    # Zero-padded ISO weeks sort correctly as text.
    return max(picks, key=lambda p: p["week"])


def _person_slugs(row):
    return {slugify(row.get("Person Name")), slugify(row.get("Person Key"))} - {""}


def _company_slugs(row):
    return {slugify(row.get("Company")), slugify(row.get("Company Key"))} - {""}


def _record(row):
    """The row's keys exactly as personKey()/companyKey() in web/src/lib/psc.ts
    build them, so the site's recheck can find this very row again."""
    def key(canon, name):
        return str(row.get(canon) or "").strip() or str(row.get(name) or "").strip().lower()
    return {"person": key("Person Key", "Person Name"), "company": key("Company Key", "Company")}


def _load(data_dir, name):
    path = os.path.join(data_dir, name)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _register_bullet(row):
    person = str(row.get("Person Name", "")).strip()
    company = str(row.get("Company", "")).strip()
    pct = str(row.get("Percentage") or "").strip()
    nature = str(row.get("Nature of Control") or "").strip()
    role = str(row.get("Board Role") or "").strip()
    if pct:
        text = f"{person} is reported to hold {pct} of {company}" + (f" ({nature})" if nature else "")
    elif row.get("Kind") == "role" and role:
        text = f"{person} is reported as {role} of {company}"
    else:
        text = f"{person} is reported to control {company}" + (f" ({nature})" if nature else "")
    url = str(row["Source URL"]).strip()
    outlet = str(row.get("Publisher") or "").strip() or re.sub(r"^https?://(www\.)?([^/]+).*$", r"\2", url)
    return {"kind": "register", "text": text, "outlet": outlet, "url": url,
            "date": str(row.get("Date", ""))[:10], "record": _record(row)}


def _news_bullet(article):
    return {"kind": "news", "text": f"{article.get('Source', '').strip()} reported: \"{article.get('Title', '').strip()}\"",
            "outlet": str(article.get("Source", "")).strip(), "url": str(article.get("URL", "")).strip(),
            "date": str(article.get("Time", ""))[:10]}


def gather(pick, register, articles, people, hidden=()):
    """The pick's published facts as bullets, and whether the finding names a person.

    `hidden` is the owner's unpublished names (suppressed.json): a pick naming
    one is refused, and every row and article naming one is left out, as the
    site's loaders leave them out."""
    if hidden:
        unpublished = suppression.matcher(hidden)
        for field in ("entity", "record_ref", "headline", "note"):
            if unpublished(pick.get(field)):
                raise Refusal(f"the {field} names someone or something the owner has unpublished "
                              "(suppressed.json); the site leaves out everything naming them")
        register = suppression.without(register, hidden)
        articles = suppression.without(articles, hidden)
        people = suppression.without(people, hidden)
    public = [r for r in register if is_public(r)]
    backed_people = set().union(*(_person_slugs(r) for r in public)) if public else set()
    # People the site may not name: those only in withheld register rows or in
    # the appointments feed, with no published register row behind them.
    unbacked = {s for r in register if not is_public(r) for s in _person_slugs(r)}
    unbacked |= {slugify(p.get("Name")) for p in people} - {""}
    unbacked -= backed_people

    for field in ("headline", "note"):
        for slug in sorted(unbacked):
            if mentions(pick.get(field, ""), slug):
                raise Refusal(f"the {field} names {_display(slug, register, people)}, "
                              "who has no published register row; a finding never names a person without the register's evidence")

    if pick.get("record_ref"):
        ref = pick["record_ref"]
        person, _, company = ref.partition("/")
        rows = [r for r in public if person in _person_slugs(r) and company in _company_slugs(r)]
        if not rows:
            raise Refusal(f"{ref!r} is not in the published exports (no published register row for this holding)")
        names = {person, company} | {s for r in rows for s in _company_slugs(r) | _person_slugs(r)}
    elif pick.get("entity"):
        ref = pick["entity"]
        if ref in withheld_companies(register):
            raise Refusal(f"{ref!r} is not in the published exports: every register row naming this company "
                          "is withheld (no source link, or quarantined), so the site would drop the finding")
        if ref in unbacked:
            raise Refusal(f"{ref!r} is not in the published exports: the register gate withholds it, "
                          "or no published register row backs naming this person")
        rows = [r for r in public if ref in _person_slugs(r) | _company_slugs(r)]
        names = {ref} | {s for r in rows for s in (_company_slugs(r) if ref in _company_slugs(r) else _person_slugs(r))}
    else:
        raise Refusal("a pick needs a record_ref (person-slug/company-slug) or an entity slug")

    bullets = []
    seen = set()
    for r in sorted(rows, key=lambda r: str(r.get("Date", "")), reverse=True):
        b = _register_bullet(r)
        if b["url"] not in seen:
            seen.add(b["url"])
            bullets.append(b)

    for a in sorted(articles, key=lambda a: str(a.get("Time", "")), reverse=True):
        url = str(a.get("URL", "")).strip()
        if not re.match(r"^https?://", url) or url in seen:
            continue
        entities = {slugify(e) for e in str(a.get("Entities", "")).split("|")}
        if not (entities & names or any(mentions(a.get("Title", ""), n) for n in names)):
            continue
        # News that names a person the register does not back stays out.
        if any(mentions(f"{a.get('Title', '')} {a.get('Entities', '')}", s) for s in unbacked):
            continue
        seen.add(url)
        bullets.append(_news_bullet(a))

    if not bullets:
        raise Refusal(f"{ref!r} is not in the published exports (no published register row or article)")
    if len(bullets) < MIN_BULLETS:
        raise Refusal(f"{ref!r} has only {len(bullets)} published fact; a finding needs at least {MIN_BULLETS}")
    # A slug with no published person row could still be a person. Only a
    # name the data files as a company is safe to draft without one.
    if pick.get("entity") and ref not in backed_people and ref not in known_companies(register, people):
        raise Refusal(f"{ref!r} is not a company the register or appointments name, and no published "
                      "register row backs it as a person; it may name someone the register does not back")
    bullets = bullets[:MAX_BULLETS]
    return bullets, names_person(pick, bullets, register, articles, people), ref


def withheld_companies(register):
    """Company slugs that appear only in rows the register gate withholds."""
    published = set().union(*(_company_slugs(r) for r in register if is_public(r)))
    return {s for r in register if not is_public(r) for s in _company_slugs(r)} - published


def known_companies(register, people):
    """Slugs the data files as companies: register companies and the
    organisations in the appointments feed."""
    return ({s for r in register for s in _company_slugs(r)}
            | {slugify(p.get("Organization")) for p in people}) - {""}


def names_person(pick, bullets, register, articles, people):
    """Whether the finding may name a person anywhere, which keeps its page out
    of search and the sitemap. It answers False only when it is sure: no
    register bullet (each names a holder), no person AURA knows in the
    headline, note or bullets, and every entity tagged on a cited article is
    a company the data knows. The pick's own slug proves nothing: it could be
    a person. Anything else could be a person, so it counts as one."""
    if any(b["kind"] == "register" for b in bullets):
        return True
    known_people = {s for r in register for s in _person_slugs(r)} | {slugify(p.get("Name")) for p in people}
    text = " ".join([str(pick.get("headline", "")), str(pick.get("note", ""))] + [b["text"] for b in bullets])
    if any(mentions(text, s) for s in known_people - {""}):
        return True
    companies = known_companies(register, people)
    cited = {b["url"] for b in bullets}
    tags = {slugify(e) for a in articles if str(a.get("URL", "")).strip() in cited
            for e in str(a.get("Entities", "")).split("|")} - {""}
    return not tags <= companies


def _display(slug, register, people):
    for r in register:
        if slugify(r.get("Person Name")) == slug:
            return r["Person Name"]
    for p in people:
        if slugify(p.get("Name")) == slug:
            return p["Name"]
    return slug


def _fit(text, limit):
    """Cut at a word boundary with an ellipsis so drafts stay under each platform's cap."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip()
    return cut + "…"


def drafts(headline, note, bullets, link):
    """Template-built share text; every piece ends with the link to the finding page."""
    lines = [f"• {b['text']} ({b['outlet']}, {b['date']})" for b in bullets]
    title = f"Ownership Finding of the Week: {headline}"

    footer = f"\n\nEvery fact links to the original reporting. The full finding: {link}"
    body = "\n\n".join(part for part in (title, "\n".join(lines), note) if part)
    linkedin = _fit(body, LINKEDIN_MAX - len(footer)) + footer

    x = _fit(title, X_MAX - len(link) - 1) + " " + link

    sourced = "\n".join(f"- {b['text']} ({b['outlet']}, {b['date']}): {b['url']}" for b in bullets)
    email_body = "\n\n".join(part for part in (
        "Hello,",
        "I run AURA, which maps who controls Nigerian companies from published reporting. "
        f"This week's finding: {headline}",
        sourced,
        note,
        f"Each point links to the outlet that reported it. The finding, with sources:\n{link}",
    ) if part)
    return {"linkedin": linkedin, "x": x,
            "email": {"subject": _fit(f"Ownership finding: {headline}", 120), "body": email_body}}


def draft(data_dir, site=DEFAULT_SITE):
    findings_dir = os.path.join(data_dir, "findings")
    pick = latest_pick(_load(findings_dir, "picks.json"))
    bullets, names_person, ref = gather(
        pick, _load(data_dir, "significant_control.json"), _load(data_dir, "latest.json"), _load(data_dir, "people.json"),
        suppression.load(data_dir))
    week = pick["week"]
    link = f"{site.rstrip('/')}/findings/{week}/"
    headline = str(pick.get("headline", "")).strip()
    note = str(pick.get("note", "")).strip()
    finding = {
        "week": week,
        "headline": headline,
        "note": note,
        "ref": ref,
        "names_person": names_person,
        "link": link,
        "bullets": bullets,
        "drafts": drafts(headline, note, bullets, link),
    }
    path = os.path.join(findings_dir, f"{week}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(finding, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return path, finding


def summary(finding):
    """Markdown the workflow prints to the job summary for the owner to copy."""
    d = finding["drafts"]
    return "\n\n".join([
        f"## Finding {finding['week']}: {finding['headline']}",
        "### LinkedIn", f"```\n{d['linkedin']}\n```",
        "### X", f"```\n{d['x']}\n```",
        f"### Email: {d['email']['subject']}", f"```\n{d['email']['body']}\n```",
    ])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", default=DEFAULT_DATA)
    parser.add_argument("--site", default=DEFAULT_SITE)
    args = parser.parse_args(argv)
    try:
        path, finding = draft(args.data_dir, args.site)
    except Refusal as err:
        print(f"draft_finding: refused: {err}", file=sys.stderr)
        return 1
    print(summary(finding))
    print(f"\nWrote {os.path.relpath(path, REPO)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
