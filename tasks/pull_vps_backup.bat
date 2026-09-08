@echo off
setlocal enabledelayedexpansion
rem Pull the VPS's backups to this machine. This is the ONLY offsite copy of the box
rem that trades continuously, and it runs on the laptop because the VPS cannot reach
rem back here.
rem
rem It used to fetch "Select-Object -First 1" - the single newest zip. So every day the
rem laptop was asleep became a PERMANENT hole in the chain: on 2026-08-21 the pull log
rem jumped 08-19 -> 08-21 and backup_20260820 was simply never collected, even though
rem the VPS had made it on schedule. The VPS keeps 14 days, so a laptop outage longer
rem than that would lose those days for good. Now it pulls everything it is missing.
set KEY=C:\Users\User\.ssh\contabo_smartentry
set VPS=administrator@169.58.74.133
set DEST=C:\Users\User\ai-trading-dashboard\vps-backups

if not exist "%DEST%" mkdir "%DEST%"

ssh -i "%KEY%" %VPS% "powershell -Command Get-ChildItem C:\ai-trading-dashboard-backups\*.zip ^| Sort-Object LastWriteTime ^| Select-Object -ExpandProperty Name" > "%DEST%\remote_names.txt" 2>>"%DEST%\pull_errors.txt"

set PULLED=0
set MISSING=0
for /f "usebackq delims=" %%F in ("%DEST%\remote_names.txt") do (
  set "NAME=%%F"
  if not "!NAME!"=="" (
    if not exist "%DEST%\!NAME!" (
      set /a MISSING+=1
      scp -i "%KEY%" "%VPS%:/C:/ai-trading-dashboard-backups/!NAME!" "%DEST%\!NAME!" 2>>"%DEST%\pull_errors.txt"
      if exist "%DEST%\!NAME!" (
        set /a PULLED+=1
        echo [%date% %time%] Pulled !NAME! from VPS >> "%DEST%\pull_log.txt"
      ) else (
        echo [%date% %time%] FAILED to pull !NAME! >> "%DEST%\pull_log.txt"
      )
    )
  )
)

if "%MISSING%"=="0" (
  echo [%date% %time%] Up to date - nothing missing >> "%DEST%\pull_log.txt"
) else (
  echo [%date% %time%] Catch-up complete - %PULLED% of %MISSING% missing backups pulled >> "%DEST%\pull_log.txt"
)

rem ── the deep analysis report ────────────────────────────────────────────────
rem The laptop served a 26-DAY-OLD analysis. tasks\analysis\latest.json here was
rem dated 08-03 while the VPS had a fresh one from 01:01 that morning, and
rem /api/analysis handed out that stale verdict with 12 "actions" and 6 "blind
rem spots" describing 213/104/611 closed trades - replay numbers, against a live
rem journal holding 7 fills.
rem
rem PULLED, NOT RECOMPUTED, and that is the whole point. The job is six replays,
rem five analysts in parallel and a synthesiser - 6+ Claude calls. Scheduling it
rem here would cost that every night to produce a near-identical answer AND would
rem mostly not run, because this laptop is asleep at 01:00 by design. The VPS
rem never sleeps, already runs it, and is the box that trades. Copy its answer.
rem
rem Ordering is deliberate: SmartEntryAnalysis writes at 01:00, this pull is 04:00.
rem Non-fatal by construction - a failed copy leaves the previous file untouched
rem and the route keeps reporting its own ageHours honestly.
scp -i "%KEY%" "%VPS%:/C:/ai-trading-dashboard/tasks/analysis/latest.json" "C:\Users\User\ai-trading-dashboard\tasks\analysis\latest.json" 2>>"%DEST%\pull_errors.txt"
if exist "C:\Users\User\ai-trading-dashboard\tasks\analysis\latest.json" (
  echo [%date% %time%] Pulled deep-analysis latest.json from VPS >> "%DEST%\pull_log.txt"
) else (
  echo [%date% %time%] FAILED to pull deep-analysis latest.json >> "%DEST%\pull_log.txt"
)

rem The PEER box's pipeline health, for the fleet column on /dashboard/pipelines.html.
rem Each box indexes only ITSELF, and the VPS is the machine that trades - its ledgers
rem were the ones going unscored for weeks, which is precisely the case a one-box view
rem cannot show.
rem
rem PULLED rather than fetched live: the VPS serves /dashboard behind its login gate
rem and this laptop holds no session for it. The copy is up to a day old and the page
rem says so from the file's own generatedAt - a stale peer column that admits its age
rem beats a live one that does not exist.
scp -i "%KEY%" "%VPS%:/C:/ai-trading-dashboard/dashboard/pipeline-latest.json" "C:\Users\User\ai-trading-dashboard\dashboard\pipeline-peer.json" 2>>"%DEST%\pull_errors.txt"
if exist "C:\Users\User\ai-trading-dashboard\dashboard\pipeline-peer.json" (
  echo [%date% %time%] Pulled peer pipeline index >> "%DEST%\pull_log.txt"
) else (
  echo [%date% %time%] FAILED to pull peer pipeline index >> "%DEST%\pull_log.txt"
)

rem Keep more than the VPS does, so this copy outlives the source.
rem
rem SORTED BY NAME, NOT LastWriteTime. scp does not preserve the source mtime, so every
rem archive here carries the time it was COPIED, not the time the backup was MADE -
rem measured 2026-09-08: all 21 zips had mtimes inside a 60-second window from that run's
rem pull, one per second in transfer order. Sorting a retention on that key means the file
rem chosen for deletion is decided by transfer order rather than by age, and on 2026-09-08
rem a 09-08 07:00 archive was gone from this folder while 09-02 archives remained.
rem
rem The filename carries the real timestamp - backup_YYYYMMDD_HHMMSS.zip - and sorts
rem lexicographically in true chronological order, so it is the only reliable key here.
rem
rem COUNT 21 -> 180, owner's call taken 2026-09-08.
rem
rem 21 was NOT keeping "more than the VPS does" as the line above intends: the VPS keeps
rem 48 ($KEEP_BACKUPS in tasks/vps_backup.ps1), so the bucket was holding LESS THAN HALF
rem of the source it exists to outlive. Measured the same day: 21 archives spanned 3.5
rem days, and tasks/backup_history_check.cjs could therefore see no further back than
rem that. A deletion older than 3.5 days was invisible AND unrecoverable.
rem
rem WHY THE DEPTH IS THE POINT. bucket_audit.cjs proves the backup RAN; it cannot prove
rem nothing was LOST, because an archive taken after a deletion faithfully preserves the
rem deletion and passes every check thereafter. The only defence against a silent loss is
rem having an archive from BEFORE it - so retention is exactly how long you have to
rem notice. 3.5 days was the window. 180 makes it 30.
rem
rem THE ARITHMETIC, because "keep more" without it is how a disk fills:
rem   6 runs/day x 30 days = 180 archives.  Measured average 13 MB -> ~2.3 GB.
rem   Free on C: at the time of the change: 316 GB. The cost is 0.7% of free space.
rem Raising a retention only ever deletes LESS, so this cannot lose an archive that the
rem old value would have kept.
powershell -Command "Get-ChildItem '%DEST%\*.zip' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 180 | Remove-Item -Force"
endlocal
