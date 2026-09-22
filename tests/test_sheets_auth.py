"""The Google Sheets client (gspread + google-auth) that excel_db.py's
SheetsDatabase.__init__ actually calls at production runtime -- previously
absent from requirements-ci.txt, so a green CI run on a gspread/google-auth
Dependabot bump never meant anything (see docs on the 2026-09-22 bumps).

Exercises the real library against a throwaway RSA key that was generated
for this test alone and used for nothing else. Everything here stays local:
from_service_account_info/_file only parse and validate the key, and
gspread.authorize only wraps the resulting credentials -- no network call
happens until a caller actually opens a spreadsheet, which none of this
does.
"""
import json

import gspread
from google.oauth2.service_account import Credentials

FAKE_PRIVATE_KEY = """-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCZGnhl/5P18HTC
F7EXKnPjEzVT/zHXWlL94yM9UaYa82zHdrjUrmy8dp8LJJnyovqFFLt5XCVI6PR4
Unp0aQ2+k9rvHFEpYkObHvCWEUG8HyLk/vlw+Kg+6JPzOrpJxJsgPoJqGNjmUnC9
MIi2RmTOiAxwl9Q7TvQFxS09hOja3Zh4qhH+GIzMtKLYyVI+NukdQrwSw1GWvi7C
F+DcrJPjmQwNfUf/Jjz/v4KSRAGJm1TqRXMbMfrn29GmFW2ha1Rzb8DDSzXsl7bQ
BursB/B+Nvb18ofwaxNVHSsVKr6fFQAtMcv4jQjENCaeR57d5RDkFS/nBPNxlDDX
dJ0BGRaBAgMBAAECggEAB0ahQyOmufDf85thoJq1YCy5A5FkonnZ6NPjCFZ5gN1h
pYcIWJ8jbr9qZoKqSEQjiLCICkftQ65Cc/djd2XIr+5h4KwlVUSkttn9D/yo9ZI7
O8u8OfivMjImWdBIKxpLTvh5hSZCJIv1bKBCVvs4bjI7+RvWC62AXkfVEw/eaww7
ESqSN6aVXWkP83AGumgbsZr/SFjzR82ajcU5uhbcIgKSZt8eHUKB5F5TcT2C2VjL
xb6/dB3M4h15QA1vEIrAXbOQp7uyjBLhhLauerZ7Y6PhO//+ueui3h/RPm/9HZvU
0XK4AMH3XlakNUmVbnYlTjP0flLdvNv8OWaqZj1wcwKBgQDJ32tUqPl9Y8d1crJw
OoPxStJTNdQ7zOGhYuq8K7SSPFxXtjmK7QRiFVu0vtcr3Aqh555nAO9BU4wRqKog
D/bGFoE8ad0unN8V9KuHk0jJaB2yAOYyltD5kB6H7n4AXSVLQTuOwGJkmdZIGy5j
VrGT9vUvBcf1+xc9a/freMkl4wKBgQDCJ4Pqz1KDgzGzAjkQF0Z1+cEYKL2iMyoT
Mo/cdMDAmw4lxriU4xCfX+mYBeW86FLWOmE/E0tQf5wfDDMHtBMzyWUt0Dcjup+N
CjE/Jd7UtzjiVOlCFPq9XA5Y/TqRfmVgZq1/4ed6A9DbmZio4uz7ml+GYnZRHrmv
3Sxne0GfSwKBgHnCuXE57inUShUsFjadBMJAN/YajKV5IUp/aEgRMHvXznbVIYYL
Cc7DRSoSxaPdt8gJ9T/5j1Xet6hbDCoElvrJzi+LRu57jg8nIWLH0mow02BvLGmt
D+THKbMhhXxgskLe2LZ0kaROKbIaOvON8dPma+Jt4TsbtNvGSKYNl32zAoGAF1Uw
YVOxEuT9YAnwWaKycRMmxYR/5bJIaC43Y8MUNxFrTdbn79yp7r1UEVUEGwPAkMZL
UY08C9yKIqEQsOhPNnYJlsvjFIQlEIodCP3AHcg3KdwSfEKRL5iUkNU96KZMAJ3W
U/wOGXfD7eAznHhJCqOuvzOuDGmo3x2xbG4/oKkCgYAK7rIkXxizXYuf9uKMQDJR
v5KOJTqAtgd62pz1SdLT3xuaAYWAtvGN+MEWXMvgM05qSWlXa9rBP5xr4wAYZCG9
D9qk+0AnAq9kaHOl84jxR9/fDMpusjOZyzwXDG3dDYRA7Ul5tjc0Ltx1lpzA90+y
J0oQ7jFEo8RISHfaIZxYFw==
-----END PRIVATE KEY-----
"""

FAKE_SERVICE_ACCOUNT_INFO = {
    "type": "service_account",
    "project_id": "aura-test",
    "private_key_id": "test-key-id",
    "private_key": FAKE_PRIVATE_KEY,
    "client_email": "aura-test@aura-test.iam.gserviceaccount.com",
    "client_id": "000000000000000000000",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": (
        "https://www.googleapis.com/robot/v1/metadata/x509/"
        "aura-test%40aura-test.iam.gserviceaccount.com"
    ),
}

# excel_db.py's own scopes list, kept identical so a scope-handling
# regression in either library would actually surface here.
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def test_from_service_account_info_matches_excel_db_usage():
    """The branch excel_db.py takes when GOOGLE_SERVICE_ACCOUNT_JSON is a
    JSON string (json.loads then Credentials.from_service_account_info)."""
    creds = Credentials.from_service_account_info(FAKE_SERVICE_ACCOUNT_INFO, scopes=SCOPES)
    assert creds.service_account_email == FAKE_SERVICE_ACCOUNT_INFO["client_email"]
    assert creds.scopes == SCOPES


def test_from_service_account_file_matches_excel_db_usage(tmp_path):
    """The other branch: GOOGLE_SERVICE_ACCOUNT_JSON holding a file path."""
    path = tmp_path / "service_account.json"
    path.write_text(json.dumps(FAKE_SERVICE_ACCOUNT_INFO))
    creds = Credentials.from_service_account_file(str(path), scopes=SCOPES)
    assert creds.service_account_email == FAKE_SERVICE_ACCOUNT_INFO["client_email"]


def test_gspread_authorize_wraps_the_credentials():
    """excel_db.py's next line after building creds: gspread.authorize(creds)."""
    creds = Credentials.from_service_account_info(FAKE_SERVICE_ACCOUNT_INFO, scopes=SCOPES)
    client = gspread.authorize(creds)
    assert isinstance(client, gspread.Client)
