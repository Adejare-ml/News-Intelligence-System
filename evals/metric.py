"""
Scoring for the DSPy extraction program, in GEPA's feedback-metric shape.

GEPA improves a program by reflecting on *why* an output was poor, so a bare
float throws away most of what it can do. Every branch below returns a sentence
naming the rule that was broken, phrased as an instruction the optimiser can act
on.

The scoring is deliberately asymmetric. Some errors are ordinary inaccuracy and
cost a fraction of the score; three are disqualifying and score zero however
good the rest of the extraction is:

  * fabricating a percentage,
  * listing the publication as a party to the story,
  * publishing an off-topic article as relevant.

They score zero because they are the failures that put false statements into a
beneficial-ownership register, and because GEPA optimises exactly what the
metric measures. A rule that only costs a fraction is a rule the optimiser is
free to trade away for gains elsewhere.
"""
from typing import Any, Dict, List, Optional, Tuple

from backend.app.services.relevance import is_publication_or_furniture, off_topic_reason

# Numeric fields are judgement calls, not facts; anything inside this band
# counts as agreement rather than error.
SCORE_TOLERANCE = 20


def _norm(value: Any) -> str:
    return " ".join(str(value or "").split()).strip().lower()


def _get(obj: Any, key: str, default=None):
    """Read from a dict or an object, so gold dicts and Predictions both work."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _as_dicts(items: Any) -> List[Dict[str, Any]]:
    out = []
    for item in items or []:
        if isinstance(item, dict):
            out.append(item)
        elif hasattr(item, "model_dump"):
            out.append(item.model_dump())
        else:
            out.append({k: getattr(item, k) for k in dir(item) if not k.startswith("_")})
    return out


def _set_f1(gold: List[Tuple], pred: List[Tuple]) -> float:
    g, p = set(gold), set(pred)
    if not g and not p:
        return 1.0
    if not g or not p:
        return 0.0
    tp = len(g & p)
    if not tp:
        return 0.0
    precision, recall = tp / len(p), tp / len(g)
    return 2 * precision * recall / (precision + recall)


def _psc_keys(records: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    return [(_norm(r.get("name")), _norm(r.get("organization"))) for r in records]


def _org_keys(records: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    return [(_norm(r.get("name")), _norm(r.get("type"))) for r in records]


def _people_keys(records: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    return [(_norm(r.get("name")), _norm(r.get("organization"))) for r in records]


def _fabricated_percentages(
    article_text: str, pred_psc: List[Dict[str, Any]]
) -> List[str]:
    """
    Percentages asserted by the model that do not appear in the source text.

    The rule is "only populate a percentage when a figure is stated", so the
    check is literal: the digits must be findable in the article. Comparing
    against the gold record instead would miss the case where the article states
    a figure the labeller omitted, and would not catch invention at all on
    articles whose gold has no percentage.
    """
    haystack = _norm(article_text)
    offenders = []
    for record in pred_psc:
        for field in ("percentage", "direct_percentage", "indirect_percentage"):
            value = record.get(field)
            if not value:
                continue
            digits = _norm(value).replace("%", "").strip()
            if digits and digits not in haystack:
                offenders.append(f"{record.get('name') or 'unknown holder'}: {field}={value}")
    return offenders


def extraction_metric(
    gold: Any,
    pred: Any,
    trace: Optional[Any] = None,
    pred_name: Optional[str] = None,
    pred_trace: Optional[Any] = None,
    program_trace: Optional[Any] = None,
):
    """
    Score one extraction. Returns a dspy.Prediction carrying score and feedback
    when dspy is importable, and a plain (score, feedback) pair otherwise so the
    scoring can be unit-tested without the dependency.
    """
    title = _get(gold, "title", "")
    article_text = _get(gold, "article_text", "") or _get(gold, "raw_text", "")

    gold_relevant = bool(_get(gold, "relevant", False))
    pred_relevant = bool(_get(pred, "relevant", False))

    pred_orgs = _as_dicts(_get(pred, "organizations", []))
    pred_people = _as_dicts(_get(pred, "people", []))
    pred_psc = _as_dicts(_get(pred, "significant_control", []))

    gold_orgs = _as_dicts(_get(gold, "organizations", []))
    gold_people = _as_dicts(_get(gold, "people", []))
    gold_psc = _as_dicts(_get(gold, "significant_control", []))

    # --- Disqualifying failures -------------------------------------------

    fabricated = _fabricated_percentages(article_text, pred_psc)
    if fabricated:
        return _result(0.0,
            "Fabricated ownership percentage. These figures are not stated anywhere in "
            f"the article: {'; '.join(fabricated)}. Populate a percentage field only when "
            "the article states that exact figure, otherwise leave it null. An invented "
            "percentage in a beneficial-ownership register is worse than no percentage."
        )

    publications = [o.get("name") for o in pred_orgs if is_publication_or_furniture(o.get("name"))]
    if publications:
        return _result(0.0,
            f"Listed the publication or page furniture as an organization: {publications}. "
            "News outlets are the source of an article, not participants in the events it "
            "reports. Only include organizations that take part in the reported event."
        )

    if pred_relevant:
        reason = off_topic_reason(title, _get(pred, "summary", ""))
        if reason is not None:
            return _result(0.0,
                f"Marked relevant, but this is {reason.topic} coverage "
                f"(matched: {', '.join(reason.matched)}). Relevance means a change in "
                "ownership or control, an appointment, a merger, a restructuring, or a "
                "procurement or regulatory action. Sport and entertainment are never relevant."
            )

    # --- Relevance gate ----------------------------------------------------

    if gold_relevant != pred_relevant:
        direction = ("published an article that should have been filtered out"
                     if pred_relevant else
                     "filtered out an article that should have been published")
        return _result(0.0,
            f"Relevance is wrong: {direction}. This single field decides whether anything "
            "is published at all, so nothing else can compensate for it."
        )

    if not gold_relevant:
        # Correctly agreed the article is irrelevant; the other fields are moot.
        return _result(1.0, "Correctly identified as not relevant.")

    # --- Field-level scoring ----------------------------------------------

    notes: List[str] = []
    parts: List[Tuple[str, float, float]] = []  # (label, score, weight)

    for field, weight in (("category", 1.0), ("event_type", 1.0), ("risk_level", 1.0)):
        got, want = _norm(_get(pred, field)), _norm(_get(gold, field))
        ok = got == want
        parts.append((field, 1.0 if ok else 0.0, weight))
        if not ok:
            notes.append(f"{field} should be '{_get(gold, field)}', not '{_get(pred, field)}'")

    for field, weight in (("risk_score", 0.5), ("importance_score", 0.5)):
        try:
            got, want = int(_get(pred, field) or 0), int(_get(gold, field) or 0)
        except (TypeError, ValueError):
            got, want = -1, 0
        ok = abs(got - want) <= SCORE_TOLERANCE
        parts.append((field, 1.0 if ok else 0.0, weight))
        if not ok:
            notes.append(
                f"{field} of {got} is more than {SCORE_TOLERANCE} points from {want}"
            )

    psc_f1 = _set_f1(_psc_keys(gold_psc), _psc_keys(pred_psc))
    parts.append(("significant_control", psc_f1, 3.0))
    if psc_f1 < 1.0:
        notes.append(
            f"significant_control does not match: expected {_psc_keys(gold_psc)}, "
            f"got {_psc_keys(pred_psc)}. This is the field the PSC register is built from."
        )

    org_f1 = _set_f1(_org_keys(gold_orgs), _org_keys(pred_orgs))
    parts.append(("organizations", org_f1, 1.5))
    if org_f1 < 1.0:
        notes.append(f"organizations do not match: expected {_org_keys(gold_orgs)}, got {_org_keys(pred_orgs)}")

    people_f1 = _set_f1(_people_keys(gold_people), _people_keys(pred_people))
    parts.append(("people", people_f1, 1.0))
    if people_f1 < 1.0:
        notes.append(f"people do not match: expected {_people_keys(gold_people)}, got {_people_keys(pred_people)}")

    # A PSC holder must never be duplicated into `people`.
    misplaced = set(_people_keys(pred_people)) & set(_psc_keys(pred_psc))
    if misplaced:
        parts.append(("psc_leak", 0.0, 1.0))
        notes.append(
            f"{sorted(misplaced)} appears in both people and significant_control. "
            "A person with significant control belongs only in significant_control."
        )

    total_weight = sum(w for _, _, w in parts)
    score = sum(s * w for _, s, w in parts) / total_weight if total_weight else 0.0

    feedback = ("Extraction is correct." if not notes
                else "Fix the following: " + "; ".join(notes) + ".")
    return _result(round(score, 4), feedback)


def _result(score: float, feedback: str):
    try:
        import dspy
        return dspy.Prediction(score=score, feedback=feedback)
    except Exception:  # pragma: no cover - only without the dependency
        return score, feedback
