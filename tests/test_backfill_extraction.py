"""
Article extraction must return the body once.

The first real backfill produced a 510,502-character "article" from a single
Punch story. It was not many articles concatenated: it was 78 paragraphs, each
the article text starting one sentence later than the last, each 94% similar to
its neighbour.

The cause is that unclosed <p> tags are ordinary in WordPress markup, and
html.parser nests them rather than closing them as the HTML5 spec requires. The
outer paragraph then contains every following one, so lifting text from each
paragraph re-emits all its descendants and the body grows with the square of the
paragraph count.

This is the failure mode worth a test: it produces no error, no warning and a
plausible-looking record. A gold label written against that text would be
labelling the same sentences forty times over.
"""
import pytest

pytest.importorskip("bs4")

from scripts.backfill_eval_corpus import extract_text  # noqa: E402

SENTENCE = ("Femi Otedola increased his shareholding in First HoldCo according to "
            "a regulatory filing seen on Monday by reporters in Lagos")


def unclosed(n):
    """WordPress-style markup: <p> opened and never closed."""
    return "<html><body><article>" + "".join(
        f"<p>{SENTENCE}, paragraph {i}." for i in range(n)
    ) + "</article></body></html>"


def well_formed(n):
    return "<html><body><article>" + "".join(
        f"<p>{SENTENCE}, paragraph {i}.</p>" for i in range(n)
    ) + "</article></body></html>"


def test_unclosed_paragraphs_do_not_duplicate_the_body():
    text = extract_text(unclosed(10))
    # Each sentence appears exactly once, not once per enclosing paragraph.
    assert text.count("paragraph 9.") == 1
    assert text.count("paragraph 0.") == 1


def test_length_stays_linear_in_paragraph_count():
    """
    The regression signature. Quadratic growth is what turned a 13k article
    into a 510k one, so the check is on the growth rate rather than a
    fixed size.
    """
    small = len(extract_text(unclosed(5)))
    large = len(extract_text(unclosed(20)))
    # Four times the paragraphs, about four times the text -- not sixteen.
    assert large < small * 6, f"{small} -> {large} chars looks quadratic"


def test_well_formed_markup_is_unaffected():
    """Sibling paragraphs must all survive; the fix must not drop content."""
    text = extract_text(well_formed(6))
    for i in range(6):
        assert f"paragraph {i}." in text


def test_both_markup_styles_yield_the_same_sentences():
    """
    Same content, not necessarily the same bytes. Nested paragraphs come back
    as one block with spaces between the sentences, while sibling paragraphs
    keep their line breaks. That difference is cosmetic -- the extractor reads
    prose either way -- so the assertion is on the sentences present, which is
    the property that matters.
    """
    from_unclosed = extract_text(unclosed(8))
    from_well_formed = extract_text(well_formed(8))

    for i in range(8):
        assert from_unclosed.count(f"paragraph {i}.") == 1
        assert from_well_formed.count(f"paragraph {i}.") == 1

    normalise = lambda s: " ".join(s.split())
    assert normalise(from_unclosed) == normalise(from_well_formed)


def test_chrome_is_still_stripped():
    html = ("<html><body><nav>Home Politics Business Sport Opinion Everything</nav>"
            "<header>Punch Newspapers Nigeria Latest Headlines Today</header>"
            f"<article><p>{SENTENCE}, the only real paragraph.</p></article>"
            "<aside>Read more from our correspondents around the country today</aside>"
            "<footer>Copyright reserved by the publisher of this website 2026</footer>"
            "<script>analytics.track('pageview', {section: 'business'});</script>"
            "</body></html>")
    text = extract_text(html)
    assert "only real paragraph" in text
    for chrome in ("Home Politics", "Latest Headlines", "Read more", "Copyright", "analytics"):
        assert chrome not in text


def test_short_fragments_are_dropped():
    """Captions and bylines are not article text."""
    html = f"<html><body><p>Photo: EFCC</p><p>{SENTENCE}, the real one.</p></body></html>"
    text = extract_text(html)
    assert "Photo: EFCC" not in text
    assert "the real one" in text


def test_empty_page_yields_empty_string():
    assert extract_text("<html><body></body></html>") == ""
