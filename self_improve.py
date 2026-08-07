"""
JARVIS Self-Improvement Engine
Weekly codebase scan: finds real errors, dead code, missing error handling,
API mismatches, and generates AI-powered upgrade proposals.

Usage:
  python self_improve.py scan          # full scan, print findings
  python self_improve.py scan --save   # scan and save report to tasks/
  python self_improve.py last          # print last saved report
  python self_improve.py propose       # generate AI upgrade proposals (requires claude)
"""
import sys, os, json, ast, re, subprocess, time
from pathlib import Path
from datetime import datetime, timezone

from claude_agent import make_console_utf8
make_console_utf8()

ROOT      = Path(__file__).parent
TASKS_DIR = ROOT / "tasks"
REPORT_DIR = TASKS_DIR / "improvement_reports"

JS_DANGER_PATTERNS = [
    (r"eval\s*\(",          "eval() call — potential injection risk"),
    (r"exec\s*\(",          "exec() call — potential injection risk"),
    (r"\.innerHTML\s*=",    "innerHTML assignment — potential XSS"),
    (r"require\(['\"]child_process", "child_process usage — review carefully"),
    (r"console\.log\(",     "console.log left in production code"),
    (r"TODO|FIXME|HACK",    "TODO/FIXME/HACK marker left in code"),
    (r"catch\s*\(\w*\)\s*\{\s*\}", "empty catch block — errors silently ignored"),
    (r"\.catch\s*\(\s*\)",  "empty .catch() — promise rejection ignored"),
]

PY_DANGER_PATTERNS = [
    (r"except\s*:\s*pass",  "bare except:pass — all exceptions silently ignored"),
    (r"except\s+Exception\s*:\s*pass", "except Exception:pass — errors silently ignored"),
    (r"eval\s*\(",          "eval() call — potential injection risk"),
    (r"exec\s*\(",          "exec() call — potential injection risk"),
    (r"#\s*(TODO|FIXME|HACK)", "TODO/FIXME/HACK marker left in code"),
    (r"print\s*\(",         "bare print() — may be debug output"),
    (r"time\.sleep\((?:[6-9]\d|[1-9]\d{2,})", "long sleep() — blocks event loop"),
]


def _scan_js_file(path: Path) -> list:
    try:
        src = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    findings = []
    lines = src.splitlines()
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue
        for pattern, message in JS_DANGER_PATTERNS:
            if re.search(pattern, line):
                findings.append({
                    "file":    str(path.relative_to(ROOT)),
                    "line":    i,
                    "code":    stripped[:120],
                    "message": message,
                    "severity": "HIGH" if "injection" in message or "XSS" in message else "MEDIUM",
                })
                break
    return findings


def _scan_py_file(path: Path) -> list:
    try:
        src = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    findings = []
    lines = src.splitlines()
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for pattern, message in PY_DANGER_PATTERNS:
            if re.search(pattern, line):
                findings.append({
                    "file":    str(path.relative_to(ROOT)),
                    "line":    i,
                    "code":    stripped[:120],
                    "message": message,
                    "severity": "HIGH" if "injection" in message else "LOW",
                })
                break

    # AST-level check: functions with no error handling
    try:
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                has_try = any(isinstance(n, ast.Try) for n in ast.walk(node))
                has_raise = any(isinstance(n, ast.Raise) for n in ast.walk(node))
                calls = [n for n in ast.walk(node) if isinstance(n, ast.Call)]
                if len(calls) > 3 and not has_try and not has_raise:
                    findings.append({
                        "file":    str(path.relative_to(ROOT)),
                        "line":    node.lineno,
                        "code":    f"def {node.name}(...) — {len(calls)} calls, no try/except",
                        "message": f"Function '{node.name}' makes {len(calls)} calls with no error handling",
                        "severity": "MEDIUM",
                    })
    except SyntaxError:
        findings.append({
            "file":    str(path.relative_to(ROOT)),
            "line":    0,
            "code":    "",
            "message": "SyntaxError — file failed to parse",
            "severity": "HIGH",
        })

    return findings


def _check_api_contracts() -> list:
    """Verify that /api routes in index.js match what the dashboard fetches."""
    findings = []

    server_path = ROOT / "server" / "index.js"
    dash_path   = ROOT / "dashboard" / "index.html"

    if not server_path.exists() or not dash_path.exists():
        return findings

    server_src = server_path.read_text(encoding="utf-8", errors="ignore")
    dash_src   = dash_path.read_text(encoding="utf-8", errors="ignore")

    # Extract routes from server
    server_routes = set(re.findall(r"app\.(get|post|put|delete)\(['\"]([^'\"]+)['\"]", server_src))
    server_paths  = {m[1] for m in server_routes}

    # Extract fetch() calls from dashboard
    dash_fetches = re.findall(r"fetch\([`'\"]([^`'\"]+)[`'\"]", dash_src)
    dash_paths   = {f.split("?")[0] for f in dash_fetches if f.startswith("/api/")}

    for dp in dash_paths:
        # Strip query params and path params
        clean = re.sub(r"/:\w+", "/:param", dp)
        matched = any(
            clean == sp or re.sub(r"/:\w+", "/:param", sp) == clean
            for sp in server_paths
        )
        if not matched:
            findings.append({
                "file":    "dashboard/index.html",
                "line":    0,
                "code":    f"fetch('{dp}')",
                "message": f"Dashboard fetches '{dp}' but no matching route found in server/index.js",
                "severity": "HIGH",
            })

    return findings


def full_scan() -> dict:
    """Run full codebase scan. Returns findings dict."""
    findings = []
    scanned  = 0

    # Scan JS files
    js_paths = list((ROOT / "server").glob("*.js"))
    for p in js_paths:
        if "node_modules" in str(p):
            continue
        findings.extend(_scan_js_file(p))
        scanned += 1

    # Scan Python files
    py_paths = list(ROOT.glob("*.py"))
    for p in py_paths:
        findings.extend(_scan_py_file(p))
        scanned += 1

    # API contract check
    findings.extend(_check_api_contracts())

    # Sort: HIGH first
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    findings.sort(key=lambda f: order.get(f.get("severity", "LOW"), 2))

    return {
        "scan_date":   datetime.now(timezone.utc).isoformat(),
        "files_scanned": scanned,
        "total_findings": len(findings),
        "findings":    findings,
    }


def _save_report(report: dict) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ts   = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = REPORT_DIR / f"report_{ts}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path


def _last_report() -> dict | None:
    if not REPORT_DIR.exists():
        return None
    files = sorted(REPORT_DIR.glob("report_*.json"), reverse=True)
    if not files:
        return None
    try:
        return json.loads(files[0].read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def format_report(report: dict) -> str:
    lines = [
        "",
        "=" * 65,
        "  JARVIS SELF-IMPROVEMENT SCAN",
        f"  Date     : {report['scan_date'][:19]}",
        f"  Files    : {report['files_scanned']}",
        f"  Findings : {report['total_findings']}",
        "=" * 65,
    ]

    by_sev = {"HIGH": [], "MEDIUM": [], "LOW": []}
    for f in report["findings"]:
        by_sev.setdefault(f.get("severity", "LOW"), []).append(f)

    for sev in ("HIGH", "MEDIUM", "LOW"):
        group = by_sev[sev]
        if not group:
            continue
        lines.append(f"\n  [{sev}] — {len(group)} issue(s)")
        lines.append("  " + "-" * 63)
        for f in group:
            lines.append(f"  {f['file']}:{f.get('line',0)}")
            lines.append(f"    {f['message']}")
            if f.get("code"):
                lines.append(f"    > {f['code'][:100]}")

    if not report["findings"]:
        lines.append("\n  No issues found — codebase is clean.")

    lines.append("\n" + "=" * 65 + "\n")
    return "\n".join(lines)


def _run_propose(report: dict):
    """Call claude CLI to generate upgrade proposals based on findings."""
    import shutil
    claude = shutil.which("claude") or shutil.which("claude.cmd")
    if not claude:
        print("[IMPROVE] claude CLI not found — skipping AI proposals")
        return

    high = [f for f in report["findings"] if f.get("severity") == "HIGH"]
    if not high:
        print("[IMPROVE] No HIGH severity issues — no proposals needed")
        return

    issues_text = "\n".join(
        f"- {f['file']}:{f.get('line',0)} — {f['message']}"
        for f in high[:10]
    )

    prompt = (
        "You are JARVIS, a trading system AI engineer. "
        "The automated scan found these HIGH severity issues in SmartEntry Pro:\n\n"
        f"{issues_text}\n\n"
        "For each issue: state the root cause in one sentence, then give the exact code fix. "
        "Be concise — code only, no preamble. "
        "Format: FILE:LINE — ROOT CAUSE — FIX: <code snippet>"
    )

    print("[IMPROVE] Asking claude for upgrade proposals...")
    try:
        # Delegated to claude_agent.run_claude: the prompt used to go in argv, where
        # cmd.exe truncated it at the first newline, so the agent never saw the scan
        # findings it was asked to fix — and ANTHROPIC_API_KEY was left set, billing
        # credit instead of the subscription.
        from claude_agent import run_claude
        print("\n" + run_claude(prompt, timeout=120, label="self-improve")["output"])
    except subprocess.TimeoutExpired:
        print("[IMPROVE] AI proposal timed out")
    except FileNotFoundError:
        print("[IMPROVE] claude CLI not found")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return

    cmd = argv[0].lower()

    if cmd == "scan":
        print("[IMPROVE] Scanning codebase...")
        report = full_scan()
        # Save BEFORE printing. Printing first meant a console that could not encode
        # a star character killed the run before the report was written, so the file
        # `propose` needs never appeared and the whole improve loop was dead.
        saved_path = _save_report(report) if "--save" in argv else None
        print(format_report(report))
        if saved_path:
            print(f"[IMPROVE] Report saved: {saved_path}")

    elif cmd == "last":
        report = _last_report()
        if not report:
            print("[IMPROVE] No reports found. Run: python self_improve.py scan --save")
            return
        print(format_report(report))

    elif cmd == "propose":
        report = _last_report()
        if not report:
            print("[IMPROVE] No scan report found. Run scan first: python self_improve.py scan --save")
            return
        _run_propose(report)

    else:
        print(f"[IMPROVE] Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
