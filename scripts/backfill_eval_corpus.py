#!/usr/bin/env python3
"""
Recover extractor inputs for articles already in the archive.

The pipeline stored only model output, so the bodies of the articles it has
already analysed are gone. Their URLs are not, so some of the corpus can be
rebuilt by re-fetching. Expect partial success and do not treat failures as
errors: news URLs rotate, paywalls appear, and sites go down.

This is a bootstrap. Going forward `run_pipeline.capture_eval_input` records
inputs as they are analysed, which is the reliable path.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import requests  # noqa: E402

LATEST = os.path.join(os.path.dirname(__file__), "..", "backend", "app", "static", "data", "latest.json")
OUT = os.path.join(os.path.dirname(__file__), "..", "evals", "corpus", "backfill.jsonl")
UA = "Mozilla/5.0 (compatible; AURA-eval-backfill/1.0)"


def extract_text(html: str) -> str:
    """
    Article text from a page, without the quadratic duplication.

    Unclosed <p> tags are extremely common in WordPress-generated markup, and
    html.parser responds by *nesting* them rather than closing them as the HTML5
    spec says. find_all("p") then returns the outer paragraph, which contains
    every following one, and the one after that, and so on -- so each get_text()
    re-emits all its descendants and the body grows with the square of the
    paragraph count.

    That is not theoretical. The first real backfill produced a 510,502-character
    "article" from one Punch story: 78 paragraphs, each one the article text
    starting a sentence later than the last, 94% similar to its neighbour.

    Taking only paragraphs that are not inside another paragraph yields the full
    text exactly once. On well-formed markup, where paragraphs are siblings,
    every one qualifies and the behaviour is unchanged.
    """
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form"]):
        tag.decompose()

    paragraphs = [
        p.get_text(" ", strip=True)
        for p in soup.find_all("p")
        if p.find_parent("p") is None
    ]
    return "\n".join(p for p in paragraphs if len(p) > 40)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=LATEST)
    parser.add_argument("--out", default=OUT)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--min-chars", type=int, default=400,
                        help="Below this the fetch probably hit a paywall or consent wall")
    parser.add_argument("--max-chars", type=int, default=60000,
                        help="Above this the extraction is almost certainly not one article. "
                             "Real stories run 2k-20k; the first backfill produced a 510k "
                             "body from nested <p> tags. Kept as a guard against the next "
                             "parser pathology, which will look different.")
    parser.add_argument("--delay", type=float, default=1.5)
    args = parser.parse_args()

    with open(args.source, "r", encoding="utf-8") as fh:
        articles = json.load(fh)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    recovered = skipped = failed = 0

    with open(args.out, "w", encoding="utf-8") as out:
        for article in articles[: args.limit]:
            url = article.get("URL") or article.get("url")
            title = article.get("Title") or article.get("title")
            if not url or not title:
                skipped += 1
                continue
            try:
                response = requests.get(url, timeout=15, headers={"User-Agent": UA})
                response.raise_for_status()
                text = extract_text(response.text)
            except Exception as exc:
                print(f"  fetch failed: {url} ({type(exc).__name__})")
                failed += 1
                continue

            if len(text) < args.min_chars:
                print(f"  too short, likely a wall: {url} ({len(text)} chars)")
                failed += 1
                continue

            if len(text) > args.max_chars:
                # Loud rather than silent: a body this size means the extractor
                # swept in something it should not have, and a gold label built
                # on it would be labelling the wrong text.
                print(f"  IMPLAUSIBLY LONG, not one article: {url} ({len(text)} chars) -- skipped")
                failed += 1
                continue

            out.write(json.dumps({
                "title": title,
                "article_text": text,
                "url": url,
                "source": article.get("Source") or article.get("source") or "",
                "captured_at": "backfill",
            }, ensure_ascii=False) + "\n")
            recovered += 1
            time.sleep(args.delay)

    total = recovered + failed + skipped
    print(f"\nrecovered {recovered} of {total} ({failed} unreachable, {skipped} without a URL)")
    print(f"wrote {args.out}")
    print("\nThese are unlabelled inputs. See evals/README.md for what to do with them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
