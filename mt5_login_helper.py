"""
MT5 login helper — reads {login, password, server, terminalPath, portable} as JSON
from stdin, attempts to log the specified MT5 terminal into that account, and prints
a JSON result to stdout. Never logs the password anywhere (not even on failure).

Used by POST /api/mt5/login in server/index.js — that endpoint only accepts requests
from the machine's own loopback address, so credentials never cross a network hop.
"""
import sys
import json

try:
    import MetaTrader5 as mt5
except ImportError:
    print(json.dumps({"ok": False, "error": "MetaTrader5 package not installed"}))
    sys.exit(1)


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"invalid input: {e}"}))
        sys.exit(1)

    login         = req.get("login")
    password      = req.get("password")
    server        = req.get("server")
    terminal_path = req.get("terminalPath")
    portable      = bool(req.get("portable", False))

    if not login or not password or not server or not terminal_path:
        print(json.dumps({"ok": False, "error": "login, password, server, and terminalPath are required"}))
        sys.exit(1)

    try:
        login = int(login)
    except (TypeError, ValueError):
        print(json.dumps({"ok": False, "error": "login must be numeric"}))
        sys.exit(1)

    init_kwargs = {"path": terminal_path, "timeout": 15000}
    if portable:
        init_kwargs["portable"] = True

    if not mt5.initialize(**init_kwargs):
        print(json.dumps({"ok": False, "error": f"initialize failed: {mt5.last_error()}"}))
        sys.exit(1)

    if not mt5.login(login, password=password, server=server, timeout=10000):
        err = mt5.last_error()
        mt5.shutdown()
        print(json.dumps({"ok": False, "error": f"login failed: {err}"}))
        sys.exit(1)

    acc  = mt5.account_info()
    term = mt5.terminal_info()
    result = {
        "ok":      True,
        "login":   acc.login,
        "name":    acc.name,
        "server":  acc.server,
        "balance": acc.balance,
        "equity":  acc.equity,
        "leverage": acc.leverage,
        "company": term.company if term else None,
    }
    mt5.shutdown()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
