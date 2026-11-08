"""
web/src/lib/findings.ts mirrors the register gate's company aliases so the
build recheck can find a withheld company under any spelling the gate folds
into one key. If someone adds an alias in Python only, a quarantined company
could stay on a finding page under that spelling; this test catches the drift.
"""
import os
import re

from backend.app.services.register_quality import _COMPANY_ALIASES

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def test_findings_ts_mirrors_the_gates_company_aliases():
    with open(os.path.join(REPO, "web", "src", "lib", "findings.ts"), encoding="utf-8") as fh:
        source = fh.read()
    table = re.search(r"COMPANY_ALIASES: Record<string, string> = \{(.*?)\};", source, re.S)
    assert table, "COMPANY_ALIASES table not found in findings.ts"
    mirrored = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', table.group(1)))
    assert mirrored == _COMPANY_ALIASES
