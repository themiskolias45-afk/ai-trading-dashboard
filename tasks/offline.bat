@echo off
REM ============================================================================
REM OFFLINE TOOLKIT — everything in this menu runs with the internet DOWN.
REM
REM Verified, not assumed: tasks\_replay_mtf.cjs and _replay_engine.cjs read bars
REM from tasks\history\*.csv on local disk. There is no network call anywhere in
REM the replay path, so every walk-forward, sweep, search and audit below works
REM on a dead connection.
REM
REM WHAT DOES NOT WORK OFFLINE, so you are not surprised:
REM   - live prices          Yahoo and the MT5 feed both need the network
REM   - trading              the broker is remote; the bridge cannot fill
REM   - Telegram alerts      remote API
REM   - the Claude/JARVIS legs   remote API. The AI filter fails OPEN, so its
REM                              absence does not block a signal.
REM   - refreshing bars      needs MT5 connected; see option R
REM
REM Nothing here writes a setting, moves a threshold, or deletes a file. Every
REM option is read-only against history plus a report it writes into
REM tasks\analysis\.
REM ============================================================================

:menu
cls
echo ================================================================
echo   SMARTENTRY OFFLINE TOOLKIT      (no internet required)
echo ================================================================
echo.
echo   MEASURE
echo     1  Confidence-gate walk-forward      ~3 min
echo     2  RSI ceiling sweep, all three cuts  ~20 min
echo     3  Per-instrument edge, by asset      ~5 min
echo     4  Strategy search, proposes only     ~20 min
echo.
echo   AUDIT
echo     5  Backtest health heatmap            instant
echo     6  System doctor, local checks        ~1 min
echo     7  Bar cache age
echo.
echo   READ
echo     8  Latest strategy search report
echo     9  Latest ceiling sweep report
echo.
echo     R  Refresh bars from MT5   (NEEDS MT5 CONNECTED - read the warning)
echo     0  Exit
echo.
set /p choice=  Choose:

if /i "%choice%"=="1" goto gate
if /i "%choice%"=="2" goto ceiling
if /i "%choice%"=="3" goto instrument
if /i "%choice%"=="4" goto search
if /i "%choice%"=="5" goto health
if /i "%choice%"=="6" goto doctor
if /i "%choice%"=="7" goto barage
if /i "%choice%"=="8" goto readsearch
if /i "%choice%"=="9" goto readceiling
if /i "%choice%"=="R" goto refresh
if /i "%choice%"=="0" goto :eof
goto menu

:gate
echo.
echo Running the confidence-gate walk-forward. Judged on the worst SCORED fold.
node tasks\mtf_walkforward.cjs
goto done

:ceiling
echo.
echo Three independent cuts: equal-count folds, equal-time folds, per-asset cost.
echo A candidate that wins one and loses another was never a candidate.
node tasks\rsi_ceiling_walkforward.cjs
set RSI_CEILING_FOLD_MODE=time
node tasks\rsi_ceiling_walkforward.cjs
set RSI_CEILING_FOLD_MODE=
set RSI_CEILING_COST=perasset
node tasks\rsi_ceiling_walkforward.cjs
set RSI_CEILING_COST=
goto done

:instrument
echo.
echo Edge per instrument. The three assets do NOT behave alike and a pooled
echo number hides it.
node tasks\per_instrument_edge.cjs
goto done

:search
echo.
echo The searcher PROPOSES and cannot write a setting, a gate or a threshold.
echo A run that proposes nothing is the expected outcome.
node tasks\strategy_search.cjs --axis ceiling
goto done

:health
echo.
node tasks\backtest_health.cjs
goto done

:doctor
echo.
echo Local checks only. Anything needing the peer box will report unreachable,
echo which offline is correct rather than a fault.
node tasks\doctor.cjs
goto done

:barage
echo.
echo Newest cached daily bar per symbol. Every backtest below is only as current
echo as this - a sweep over stale bars returns yesterday's answer confidently.
for %%S in (XAUUSD BTCUSD SP500) do (
  echo   %%S:
  powershell -NoProfile -Command "$f='tasks\history\%%S_D1.csv'; if (Test-Path $f) { $t=[int]((Get-Content $f -Tail 1).Split(',')[0]); $d=[DateTimeOffset]::FromUnixTimeSeconds($t).UtcDateTime; '    newest bar {0:yyyy-MM-dd}  ({1} days old)' -f $d, [int]((Get-Date).ToUniversalTime()-$d).TotalDays } else { '    no cache file' }"
)
goto done

:readsearch
echo.
if exist tasks\analysis\strategy-search-latest.txt (
  type tasks\analysis\strategy-search-latest.txt
) else (
  echo No search report yet. Run option 4.
)
goto done

:readceiling
echo.
if exist tasks\analysis\rsi-ceiling-walkforward-latest.txt (
  type tasks\analysis\rsi-ceiling-walkforward-latest.txt
) else (
  echo No ceiling report yet. Run option 2.
)
goto done

:refresh
echo.
echo ================================================================
echo   REFRESH BARS FROM MT5 - READ THIS FIRST
echo ================================================================
echo.
echo   This opens a SECOND MetaTrader5 python client. A duplicate can break
echo   the IPC port the live bridge uses - the -10005 IPC timeout already on
echo   record in this project.
echo.
echo   Only run it when NO POSITION IS OPEN, and prefer a moment when the
echo   bridge is not mid-poll. It needs MT5 running and logged in, so it is
echo   the one option here that is not offline-safe.
echo.
set /p sure=  Type YES to continue, anything else to go back:
if /i not "%sure%"=="YES" goto menu
python tasks\export_mt5_history.py
goto done

:done
echo.
pause
goto menu
