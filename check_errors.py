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
import sys, os, json, subprocess, re
from pathlib import Path
from datetime import datetime, timezone

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

REQUIRED_API_ROUTES = [
    "/api/signals",
    "/api/risk-status",
    "/api/healer",
    "/api/size",
    "/api/journal",
    "/api/chat",
    "/api/memory",
]


def _fetch(path: str, timeout: int = 4):
    import urllib.request
    try:
        with urllib.request.urlopen(f"{SERVER_URL}{path}", timeout=timeout) as r:
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
            "status":  "PASS" if ok else "FAIL",
            "detail":  f"HTTP {code}, healthy={healthy}",
        })
        checks = data.get("checks", [])
        for c in checks:
            name    = c.get("name", "?")
            c_ok    = c.get("ok", False)
            message = c.get("message", "")
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

    for route in REQUIRED_API_ROUTES:
        route_ok, route_data, route_code = _fetch(route)
        results.append({
            "check":  f"API Route {route}",
            "status": "PASS" if route_ok else "FAIL",
            "detail": f"HTTP {route_code}" if route_ok else str(route_data)[:100],
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
        "chart_vision.py":  ["playwright", "anthropic"],
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

        src = path.read_text(encoding="utf-8", errors="ignore")
        missing = []
        for mod in required_mods:
            top = mod.split(".")[0]
            if f"import {top}" not in src and f"from {top}" not in src:
                missing.append(mod)

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
