"""CAMA 2020 PSC disclosure bands."""

from typing import Any




# Nigerian PSC disclosure bands.
#
# CAMA 2020 s.868, read with the CAC Persons with Significant Control
# Regulations 2022, sets the Nigerian threshold at **5%** of shares or voting
# rights -- not the 25% used by the UK PSC register and the FATF standard.
# A 6% holder is a statutory PSC in Nigeria and invisible to a UK-calibrated
# tool, so the 5-25% band is tracked as a first-class category.
SHARE_BANDS = (
    (75.0, "BAND_75_100"),
    (50.0, "BAND_50_75"),
    (25.0, "BAND_25_50"),
    (5.0, "BAND_5_25"),
)


def share_band(percentage: Any) -> str:
    """Map a percentage (number, or a string like '28.5%') onto a CAMA band.

    Returns "" when no figure was disclosed, so the UI can say "not disclosed"
    rather than implying a band that was never reported.
    """
    if percentage is None:
        return ""
    try:
        value = float(str(percentage).replace("%", "").strip())
    except (TypeError, ValueError):
        return ""
    for floor, name in SHARE_BANDS:
        if value >= floor:
            return name
    return "BELOW_THRESHOLD"
