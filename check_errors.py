"""
JARVIS Deep Error Checker
Validates the full SmartEntry Pro stack: server health, API contracts,
Python imports, JS syntax, file integrity, and route coverage.

Usage:
  python check_errors.py           # full check, print results
  python check_errors.py --json    # output as JSON
  python check_errors.py server    # check server + API only
  python check_errors.py code      # check code syntax only
  python check_errors.py files     # check critical files only
"""
import sys, os, json, subprocess, re, ast
from pathlib import Path
from datetime import datetime, timezone

# Windows consoles here default to cp1252, which cannot encode the check glyphs this
# script prints. Every run therefore died in the FINAL print with UnicodeEncodeError -
# after all the work was done - and exited 1, so a fully passing check looked like a
# crashed one. Reconfigure rather than strip the glyphs: the output is meant to be read
# by a person, and errors="replace" means an exotic character degrades to "?" instead of
# taking the whole report down with it.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT       = Path(__file__).parent
SERVER_URL = "http://localhost:3001"

CRITICAL_FILES = [
    "server/index.js",
    "server/autohealer.js",
    "server/db.js",
    "server/sizing.js",
    "dashboard/index.html",
    "CLAUDE.md",
]

NEVER_COMMIT = [
    "server/apikey.txt",
    "keys.env",
    "tasks/.tv_session.json",
]

# Method matters. /api/size and /api/chat are declared with app.post ONLY, so a GET
# against them returns 404 — which this file was reporting as a FAILED ROUTE on a
# perfectly healthy server. A checker that cries wolf on three of its seven routes
# teaches you to ignore it, which costs more than not having it.
#
# POST routes are verified by their DECLARATION in server/index.js rather than by being
# called. That is deliberate and not laziness: POSTing /api/chat spends Anthropic credit
# on every health check, and a checker must never have a side effect worth noticing.
REQUIRED_API_ROUTES = [
    ("GET",  "/api/signals"),
    ("GET",  "/api/risk-status"),
    ("GET",  "/api/healer"),
    ("GET",  "/api/journal"),
    ("GET",  "/api/memory"),      # session-gated: needs the cookie below
    ("POST", "/api/size"),
    ("POST", "/api/chat"),
]


def _session_cookie() -> str:
    """The session cookie value IS server/session_secret.txt.

    Without it every gated route answers 401, and a 401 body parses as clean JSON —
    so an unauthenticated checker reports a healthy server as broken, or worse reads
    an error object as data. Missing file is not fatal: the public routes still answer.
    """
    try:
        return (ROOT / "server" / "session_secret.txt").read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _fetch(path: str, timeout: int = 4):
    import urllib.request
    try:
        req = urllib.request.Request(f"{SERVER_URL}{path}")
        secret = _session_cookie()
        if secret:
            req.add_header("Cookie", f"smartentry_session={secret}")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode()), r.status
    except Exception as exc:
        return False, str(exc), 0


def check_server_health() -> list:
    results = []

    ok, data, code = _fetch("/api/healer")
    if ok:
        healthy = data.get("healthy", False)
        results.append({
            "check":   "Server Running",
            # Unconditional: this branch only runs when ok is True. The ternary read as
            # a real test and could never be False.
            "status":  "PASS",
            "detail":  f"HTTP {code}, healthy={healthy}",
        })
        # /api/healer returns checks as an OBJECT keyed by check name:
        #   {"signalFreshness": {"ok": true, "detail": "..."} , ...}
        # This iterated it as a list of dicts, and iterating a dict yields its KEYS —
        # plain strings — so every run died on `'str' object has no attribute 'get'`.
        # The error checker was the one thing in the stack that could not report an
        # error. Both shapes are accepted so it survives the endpoint changing back.
        checks = data.get("checks") or {}
        if isinstance(checks, dict):
            items = list(checks.items())
        else:
            items = [(c.get("name", "?"), c) for c in checks if isinstance(c, dict)]
        for name, c in items:
            if not isinstance(c, dict):
                continue
            c_ok    = c.get("ok", False)
            # The field is "detail"; "message" was never present and every line printed blank.
            message = c.get("detail") or c.get("message") or ""
            results.append({
                "check":  f"Healer/{name}",
                "status": "PASS" if c_ok else "WARN",
                "detail": message,
            })
    else:
        results.append({
            "check":  "Server Running",
            "status": "FAIL",
            "detail": f"Could not reach server: {data}",
        })
        return results

    try:
        server_src = (ROOT / "server" / "index.js").read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        server_src = ""
        results.append({
            "check":  "server/index.js readable",
            "status": "FAIL",
            "detail": str(exc)[:120],
        })

    for method, route in REQUIRED_API_ROUTES:
        if method == "GET":
            route_ok, route_data, route_code = _fetch(route)
            results.append({
                "check":  f"API GET {route}",
                "status": "PASS" if route_ok else "FAIL",
                "detail": f"HTTP {route_code}" if route_ok else str(route_data)[:100],
            })
        else:
            declared = f'app.post("{route}"' in server_src
            results.append({
                "check":  f"API {method} {route}",
                "status": "PASS" if declared else "FAIL",
                "detail": "declared in server/index.js (not invoked — a health check must not spend credit or place a trade)"
                          if declared else "no app.post declaration found",
            })

    return results


def check_critical_files() -> list:
    results = []

    for rel_path in CRITICAL_FILES:
        path = ROOT / rel_path
        if path.exists():
            size = path.stat().st_size
            results.append({
                "check":  f"File/{rel_path}",
                "status": "PASS" if size > 0 else "WARN",
                "detail": f"{size:,} bytes",
            })
        else:
            results.append({
                "check":  f"File/{rel_path}",
                "status": "FAIL",
                "detail": "FILE MISSING",
            })

    for rel_path in NEVER_COMMIT:
        path = ROOT / rel_path
        results.append({
            "check":  f"Security/{rel_path}",
            "status": "INFO",
            "detail": "exists (good — not committed)" if path.exists() else "not present",
        })

    gitignore = ROOT / ".gitignore"
    if gitignore.exists():
        content = gitignore.read_text(encoding="utf-8", errors="ignore")
        for rel_path in NEVER_COMMIT:
            fname = Path(rel_path).name
            if fname in content or rel_path in content:
                results.append({
                    "check":  f"Gitignore/{fname}",
                    "status": "PASS",
                    "detail": "correctly gitignored",
                })
            else:
                results.append({
                    "check":  f"Gitignore/{fname}",
                    "status": "WARN",
                    "detail": f"'{fname}' NOT in .gitignore — risk of committing secrets",
                })

    return results


def check_code_syntax() -> list:
    results = []

    # Python syntax check
    for py_path in sorted(ROOT.glob("*.py")):
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "py_compile", str(py_path)],
                capture_output=True, text=True, timeout=15,
            )
            ok = proc.returncode == 0
            results.append({
                "check":  f"PySyntax/{py_path.name}",
                "status": "PASS" if ok else "FAIL",
                "detail": "OK" if ok else proc.stderr.strip()[:200],
            })
        except subprocess.TimeoutExpired:
            results.append({
                "check":  f"PySyntax/{py_path.name}",
                "status": "WARN",
                "detail": "syntax check timed out",
            })

    # Node.js syntax check
    node = _find_node()
    if node:
        for js_path in sorted((ROOT / "server").glob("*.js")):
            try:
                proc = subprocess.run(
                    [node, "--check", str(js_path)],
                    capture_output=True, text=True, timeout=15,
                )
                ok = proc.returncode == 0
                results.append({
                    "check":  f"JSSyntax/{js_path.name}",
                    "status": "PASS" if ok else "FAIL",
                    "detail": "OK" if ok else proc.stderr.strip()[:200],
                })
            except subprocess.TimeoutExpired:
                results.append({
                    "check":  f"JSSyntax/{js_path.name}",
                    "status": "WARN",
                    "detail": "syntax check timed out",
                })
    else:
        results.append({
            "check":  "JSSyntax/node",
            "status": "WARN",
            "detail": "node not in PATH — JS syntax checks skipped",
        })

    return results


def _find_node() -> str | None:
    import shutil
    return shutil.which("node")


def check_python_imports() -> list:
    results = []
    PY_FILES = {
        # Not "anthropic": this file calls api.anthropic.com over raw urllib and has
        # never imported the SDK. It was flagged for years for a dependency it does
        # not have and does not need.
        "chart_vision.py":  ["playwright"],
        "voice.py":         ["sounddevice", "scipy", "whisper", "pyttsx3"],
        "notifications.py": ["smtplib", "urllib"],
        "debate_agents.py": ["concurrent.futures"],
        "memory.py":        [],
        "daily_notes.py":   [],
        "self_improve.py":  ["ast"],
        "check_errors.py":  [],
    }

    for fname, required_mods in PY_FILES.items():
        path = ROOT / fname
        if not path.exists():
            results.append({
                "check":  f"PyImport/{fname}",
                "status": "WARN",
                "detail": "file not found",
            })
            continue

        # Parse the file and look at what it ACTUALLY imports.
        #
        # This used to substring-search for "import smtplib". notifications.py line 16
        # reads `import sys, os, json, smtplib, urllib.request, subprocess` — the module
        # IS imported, but as part of a comma list, so the literal never appeared and the
        # checker reported it missing. Same for `ast` in self_improve.py. Three of the
        # eight files carried a permanent false WARN, which is how a checker teaches you
        # to ignore it. ast sees imports wherever they are, including inside functions.
        src = path.read_text(encoding="utf-8", errors="ignore")
        try:
            tree = ast.parse(src)
        except SyntaxError as exc:
            results.append({
                "check":  f"PyImport/{fname}",
                "status": "WARN",
                "detail": f"could not parse: {exc}",
            })
            continue

        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])

        missing = [m for m in required_mods if m.split(".")[0] not in imported]

        if missing:
            results.append({
                "check":  f"PyImport/{fname}",
                "status": "WARN",
                "detail": f"imports may be missing: {', '.join(missing)}",
            })
        else:
            results.append({
                "check":  f"PyImport/{fname}",
                "status": "PASS",
                "detail": "imports look correct",
            })

    return results


def check_git_state() -> list:
    results = []
    import shutil
    git = shutil.which("git")
    if not git:
        results.append({"check": "Git", "status": "WARN", "detail": "git not in PATH"})
        return results

    proc = subprocess.run(
        [git, "status", "--porcelain"],
        capture_output=True, text=True, cwd=str(ROOT), timeout=10,
    )
    dirty = [l for l in proc.stdout.splitlines() if l.strip()]

    secret_dirty = [
        l for l in dirty
        if any(s in l for s in ["apikey.txt", "keys.env", ".tv_session"])
    ]

    if secret_dirty:
        results.append({
            "check":  "Git/SecretsUnstaged",
            "status": "FAIL",
            "detail": f"SECRET FILES MODIFIED AND UNSTAGED: {secret_dirty}",
        })
    else:
        results.append({
            "check":  "Git/SecretsClean",
            "status": "PASS",
            "detail": "No secret files in working tree changes",
        })

    results.append({
        "check":  "Git/WorkingTree",
        "status": "INFO" if dirty else "PASS",
        "detail": f"{len(dirty)} uncommitted file(s)" if dirty else "clean",
    })

    proc2 = subprocess.run(
        [git, "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True, cwd=str(ROOT), timeout=10,
    )
    branch = proc2.stdout.strip()
    expected = "claude/backup-deploy-server-FWgpv"
    results.append({
        "check":  "Git/Branch",
        "status": "PASS" if branch == expected else "WARN",
        "detail": branch,
    })

    return results


def _run_checks(modes: list) -> dict:
    all_results = []

    if "server" in modes:
        all_results.extend(check_server_health())
    if "files" in modes:
        all_results.extend(check_critical_files())
    if "code" in modes:
        all_results.extend(check_code_syntax())
        all_results.extend(check_python_imports())
    if "git" in modes:
        all_results.extend(check_git_state())

    pass_count = sum(1 for r in all_results if r["status"] == "PASS")
    fail_count = sum(1 for r in all_results if r["status"] == "FAIL")
    warn_count = sum(1 for r in all_results if r["status"] == "WARN")

    return {
        "run_at":  datetime.now(timezone.utc).isoformat(),
        "results": all_results,
        "summary": {
            "total": len(all_results),
            "pass":  pass_count,
            "fail":  fail_count,
            "warn":  warn_count,
            "clean": fail_count == 0,
        },
    }


def format_results(data: dict) -> str:
    lines = [
        "",
        "=" * 65,
        "  JARVIS DEEP ERROR CHECK",
        f"  Run at : {data['run_at'][:19]}",
        f"  Total  : {data['summary']['total']} checks",
        f"  PASS   : {data['summary']['pass']}  FAIL: {data['summary']['fail']}  WARN: {data['summary']['warn']}",
        "=" * 65,
    ]

    for r in data["results"]:
        icon = {"PASS": "✓", "FAIL": "✗", "WARN": "!", "INFO": "i"}.get(r["status"], "?")
        lines.append(f"  {icon} [{r['status']:4s}] {r['check']}")
        if r["status"] != "PASS":
            lines.append(f"         {r['detail']}")

    s = data["summary"]
    if s["fail"] == 0:
        lines.append("\n  ALL CHECKS PASSED — system is healthy")
    else:
        lines.append(f"\n  {s['fail']} FAILURE(S) FOUND — review above")

    lines.append("=" * 65 + "\n")
    return "\n".join(lines)


def main():
    argv = sys.argv[1:]
    as_json = "--json" in argv
    modes_arg = [a for a in argv if not a.startswith("-")]

    if "server" in modes_arg:
        modes = ["server"]
    elif "code" in modes_arg:
        modes = ["code"]
    elif "files" in modes_arg:
        modes = ["files"]
    else:
        modes = ["server", "files", "code", "git"]

    data = _run_checks(modes)

    if as_json:
        print(json.dumps(data, indent=2))
    else:
        print(format_results(data))

    sys.exit(0 if data["summary"]["clean"] else 1)


if __name__ == "__main__":
    main()
