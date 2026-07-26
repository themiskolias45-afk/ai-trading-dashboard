# tasks/ — which script runs where

Local machine and the Contabo VPS run separate copies of this system. Scripts with
matching names but different suffixes are **not interchangeable** — running the wrong
one on the wrong machine will fail or do the wrong thing.

## Local machine only

- `start_server_local.bat` — launches the server, sourcing `keys.env`/`apikey.txt` first
- `start_bridge_A.bat` / `start_bridge_B.bat` — MT5 bridges for the two local terminal installs
- `watchdog.bat` — crash-recovery for the server + both local bridges (window-title based)

## VPS only

- `start_server_vps.bat` — same job as the local one, VPS-specific paths
- `start_bridge_A_vps.bat` / `start_bridge_B_vps.bat` — MT5 bridges pinned to the VPS's
  two terminal installs (`C:\Program Files\MetaTrader 5` and `C:\MT5-B`, the latter
  in portable mode)
- `watchdog_vps.bat` — crash-recovery via Scheduled Tasks (`schtasks /end` + `/run`),
  not window titles — the VPS runs everything headless via Task Scheduler, so there
  are no titled windows for `taskkill /fi "windowtitle eq ..."` to find
- `vps_backup.ps1` — daily snapshot of journal/learning/db/logs, runs via the
  `SmartEntryBackup` Scheduled Task
- `pull_vps_backup.bat` — **runs on the local machine**, pulls the latest VPS backup
  down via scp for off-site safekeeping (separate Scheduled Task on the local PC)

## Shared

- `proposals.json` — pending/approved findings from the weekly autonomous research
  agent (cloud-scheduled, no SSH access — reports via `/api/agent/notify`)
- `pull_vps_backup.bat` reads/writes only `vps-backups/` locally; it never touches
  the VPS's own copy

## Why they diverged

The VPS runs everything as a Scheduled Task (`onlogon` trigger, so it needs Windows
auto-logon to survive a reboot) since there's no one physically at the keyboard to
open a console window. The local scripts assume an interactive session and use
window titles for process management. Don't copy one style onto the other machine —
it won't just work, it'll fail in a way that looks like it's working (e.g. a "restart"
that silently does nothing because there's no matching window).
