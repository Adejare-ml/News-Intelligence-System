"""The promotion smoke test passes only when production serves the promoted commit.

web/scripts/build-production.sh writes the SHA of the code it built to
/version.txt, and scripts/wait_for_production.sh polls it. The page checks
that follow also pass on the previous build, which is how a promotion went
green one second after its push, before Cloudflare could have deployed it.
"""
import hashlib
import http.server
import os
import shutil
import stat
import subprocess
import threading

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..")
WAIT = os.path.join(ROOT, "scripts", "wait_for_production.sh")
BUILD = os.path.join(ROOT, "web", "scripts", "build-production.sh")
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")

PREVIOUS = hashlib.sha1(b"previous build").hexdigest()
PROMOTED = hashlib.sha1(b"promoted build").hexdigest()

needs_shell = pytest.mark.skipif(
    not (shutil.which("bash") and shutil.which("curl") and shutil.which("git")),
    reason="needs bash, curl and git",
)


@pytest.fixture
def production():
    """A stand-in for auranews.pages.dev: answers /version.txt from a list.

    Each request takes the next answer; the last one repeats. Returns the
    site URL and the paths requested.
    """
    servers = []

    def start(answers):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                status, body = answers[min(len(requests), len(answers)) - 1]
                data = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}", requests

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def wait(site, expect, attempts=3):
    env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    env.update(SITE_URL=site, VERSION_ATTEMPTS=str(attempts), VERSION_INTERVAL="0",
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    return subprocess.run(["bash", WAIT, expect], env=env, capture_output=True, text=True, timeout=60)


@needs_shell
def test_fails_while_production_still_serves_the_previous_commit(production):
    site, requests = production([(200, PREVIOUS + "\n")])
    result = wait(site, PROMOTED)
    assert result.returncode == 1, result.stdout
    error = [line for line in result.stdout.splitlines() if line.startswith("::error::")]
    assert error and PROMOTED in error[0] and PREVIOUS in error[0]
    assert len(requests) == 3


@needs_shell
def test_passes_once_cloudflare_serves_the_promoted_commit(production):
    site, requests = production([(404, "Not found"), (200, PREVIOUS + "\n"), (200, PROMOTED + "\n")])
    result = wait(site, PROMOTED, attempts=10)
    assert result.returncode == 0, result.stdout
    assert f"OK production serves {PROMOTED}" in result.stdout
    # It stops as soon as the new build is live.
    assert len(requests) == 3
    # Each poll asks with a new query string, so no cache can answer it.
    assert all(p.startswith("/version.txt?") for p in requests)
    assert len(set(requests)) == len(requests)


@needs_shell
@pytest.mark.parametrize("answer, served", [
    # A build from before version.txt existed: Cloudflare serves the 404 page.
    ((404, "<!doctype html><title>Not found</title>"), "HTTP 404"),
    # A site with no 404 page answers every path with the home page.
    ((200, "<!doctype html><html data-hero></html>"), "not a commit SHA"),
    ((200, PROMOTED[:7]), "not a commit SHA"),
])
def test_anything_but_the_promoted_sha_fails(production, answer, served):
    site, _ = production([answer])
    result = wait(site, PROMOTED, attempts=2)
    assert result.returncode == 1, result.stdout
    assert served in result.stdout and "::error::" in result.stdout


@needs_shell
@pytest.mark.parametrize("expect", ["", PROMOTED[:7], "production"])
def test_needs_a_full_sha_to_compare_against(production, expect):
    site, requests = production([(200, PROMOTED)])
    result = wait(site, expect)
    assert result.returncode == 2 and "::error::" in result.stdout
    assert requests == []


def _git(repo, *args):
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
         "-c", "tag.gpgsign=false", *args],
        cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()


@needs_shell
@pytest.mark.parametrize("tag_args", [[], ["-a", "-m", "promoted"]], ids=["lightweight-tag", "annotated-tag"])
def test_build_production_writes_the_promoted_commit_not_the_ref(tmp_path, tag_args):
    """As the scheduler calls it: by the `production` tag, from a newer checkout."""
    repo = tmp_path / "repo"
    (repo / "web" / "scripts").mkdir(parents=True)
    # Stands in for the promoted code's build: just enough output to move.
    (repo / "web" / "scripts" / "build-sites.sh").write_text(
        "set -e\ncd \"$(dirname \"$0\")/..\"\n"
        "mkdir -p out/cloudflare/data\necho home > out/cloudflare/index.html\n"
        "echo '[]' > out/cloudflare/data/suppressed.json\n"
    )
    _git(repo, "init", "-q")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "promoted code")
    promoted = _git(repo, "rev-parse", "HEAD")
    _git(repo, "tag", *tag_args, "production")
    # main moves on after the promotion (new data, untested code).
    (repo / "data.json").write_text("{}")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "data refresh")
    assert _git(repo, "rev-parse", "HEAD") != promoted

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    npm = bin_dir / "npm"
    npm.write_text("#!/bin/sh\nexit 0\n")
    npm.chmod(npm.stat().st_mode | stat.S_IXUSR)
    env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    subprocess.run(["bash", BUILD, "production"], cwd=repo, env=env, check=True, capture_output=True, text=True)

    out = repo / "out-production"
    assert (out / "version.txt").read_text() == promoted + "\n"
    assert (out / "index.html").exists()
    assert not (out / "data" / "suppressed.json").exists()


def _load(name):
    yaml = pytest.importorskip("yaml")
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as f:
        return yaml.safe_load(f)


def _steps(job):
    return {s.get("name"): s for s in job["steps"]}


def test_the_promotion_smoke_test_waits_for_the_promoted_sha_before_the_page_checks():
    jobs = _load("promote_production.yml")["jobs"]
    assert jobs["promote"]["outputs"]["sha"] == "${{ steps.resolve.outputs.sha }}"
    smoke = jobs["smoke-test"]
    assert smoke["needs"] == "promote"
    names = [s.get("name") for s in smoke["steps"]]
    wait_step = _steps(smoke)["Wait for auranews.pages.dev to serve the promoted commit"]
    assert wait_step["env"]["EXPECTED_SHA"] == "${{ needs.promote.outputs.sha }}"
    assert "scripts/wait_for_production.sh" in wait_step["run"] and "$EXPECTED_SHA" in wait_step["run"]
    assert names.index("Wait for auranews.pages.dev to serve the promoted commit") < names.index(
        "Verify auranews.pages.dev serves the promoted build"
    )
    # The script must be in the job's checkout, which comes first.
    checkout = next(s for s in smoke["steps"] if str(s.get("uses", "")).startswith("actions/checkout"))
    sparse = checkout.get("with", {}).get("sparse-checkout")
    assert sparse is None or "scripts" in sparse.split()
    assert names.index(checkout["name"]) < names.index("Wait for auranews.pages.dev to serve the promoted commit")


def test_data_refreshes_build_production_from_the_production_tag():
    # build-production.sh writes the commit the tag names to version.txt, so
    # the file stays on the promoted SHA between promotions.
    job = _load("news_scheduler.yml")["jobs"]["deploy-pages"]
    run = _steps(job)["Build production (promoted code, this run's data)"]["run"]
    assert "REF=production" in run
    assert 'build-production.sh "$REF"' in run
    publish = _steps(job)["Publish production (cloudflare-pages)"]
    assert publish["with"]["folder"] == "out-production"
