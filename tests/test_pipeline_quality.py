"""Pipeline data quality: missing cells stored and exported as blanks,
the procurement rollup counted after dedupe, and the export refusing to
publish an empty site over a full one.
"""
import pytest

from backend.app.pipeline.cells import clean_cell


class TestCleanCell:
    @pytest.mark.parametrize("value", [
        None, "", "  ", "None", "none", "null", "NULL", "N/A", "n/a", "NA",
        "nan", "NaN", "TBD", "tbd", "-", "—", " N/A ",
    ])
    def test_placeholders_read_as_blank(self, value):
        assert clean_cell(value) == ""

    def test_real_text_is_stripped_not_changed(self):
        assert clean_cell("  Julius Berger Plc ") == "Julius Berger Plc"
        assert clean_cell("N1.2bn") == "N1.2bn"
        assert clean_cell(0) == "0"
