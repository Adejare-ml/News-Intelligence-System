"""
Ask AURA's research agent (Claude Haiku with web search) a question.

    python scripts/research.py "Who are the shareholders of Dangote Cement?"

Prints the answer with its sources, and in GitHub Actions also writes them
to the job summary. Needs ANTHROPIC_API_KEY.
"""
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app.services import claude_llm  # noqa: E402


def render(question: str, result: dict) -> str:
    lines = [f"### {question}", "", result["answer"], ""]
    if result.get("sources"):
        lines.append("**Sources**")
        lines += [f"- [{s.get('title') or s['url']}]({s['url']})" for s in result["sources"]]
        lines.append("")
    lines.append(f"_Confidence: {result.get('confidence', 'low')}. Research by Claude from web pages; check the sources before relying on it._")
    return "\n".join(lines)


def main(argv: list) -> int:
    question = " ".join(argv[1:]).strip()
    if not question:
        print(__doc__.strip())
        return 2
    if not claude_llm.configured():
        print("research: ANTHROPIC_API_KEY is not set.")
        return 1
    result = claude_llm.research(question)
    if not result:
        print("research: no answer (the request failed; see the log above).")
        return 1
    text = render(question, result)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
