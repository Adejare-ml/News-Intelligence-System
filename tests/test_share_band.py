"""Nigerian PSC disclosure bands (CAMA 2020 s.868).

The threshold that matters here is 5%, not the 25% used by the UK PSC register
and the FATF standard. These tests pin that down, because getting it wrong
silently reclassifies every Nigerian small-stake holder as "not a PSC".
"""

import pytest

from run_pipeline import share_band


@pytest.mark.parametrize(
    "percentage, expected",
    [
        ("81.4%", "BAND_75_100"),
        ("75%", "BAND_75_100"),
        ("100%", "BAND_75_100"),
        ("63.2%", "BAND_50_75"),
        ("50.0%", "BAND_50_75"),
        ("28.5%", "BAND_25_50"),
        ("25%", "BAND_25_50"),
        # The band that only exists in Nigeria: a statutory PSC here, and
        # invisible to a 25%-calibrated tool.
        ("6.8%", "BAND_5_25"),
        ("5%", "BAND_5_25"),
        ("24.99%", "BAND_5_25"),
        ("4.9%", "BELOW_THRESHOLD"),
        ("0%", "BELOW_THRESHOLD"),
    ],
)
def test_known_percentages_map_to_the_expected_band(percentage, expected):
    assert share_band(percentage) == expected


def test_numeric_input_is_accepted():
    assert share_band(28.5) == "BAND_25_50"
    assert share_band(4) == "BELOW_THRESHOLD"


@pytest.mark.parametrize("missing", [None, "", "  ", "N/A", "unknown", "Pending"])
def test_undisclosed_values_return_empty_rather_than_a_band(missing):
    """An unparseable figure must not be silently reported as a real band."""
    assert share_band(missing) == ""


def test_five_percent_is_the_threshold_not_twenty_five():
    """Regression guard against re-importing the UK 25% threshold."""
    assert share_band("5.0%") == "BAND_5_25"
    assert share_band("4.99%") == "BELOW_THRESHOLD"
    assert share_band("24.0%") != "BELOW_THRESHOLD"
