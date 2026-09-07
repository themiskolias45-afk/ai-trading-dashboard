@echo off
REM Repairs the Claude CLI after an npm update leaves the binary broken.
REM
REM WHY THIS EXISTS: npm's allow-scripts security blocks the postinstall step that
REM builds the executable shim. The package updates, the shim does not get rebuilt,
REM and `claude` then exits SILENTLY - no output, no error, no version. That looks
REM identical to a PATH problem, which is why it cost a session to diagnose the
REM first time. Running the package's own installer rebuilds the shim.
REM
REM `npm approve-scripts -g` does NOT solve it - npm rejects global installs with
REM EGLOBAL - so calling install.cjs directly is the route that works.
REM
REM NOT the same failure as "Auto-update failed: claude.exe in use". That one is
REM protective: the update did not apply and the binary is intact. This script is
REM for the case where it DID apply and left the shim unbuilt.

setlocal

set "INSTALLER=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\install.cjs"

if not exist "%INSTALLER%" (
  echo [FAIL] Installer not found at:
  echo        %INSTALLER%
  echo.
  echo        The package may live elsewhere. Find it with:  npm root -g
  exit /b 1
)

echo Rebuilding Claude CLI shim...
node "%INSTALLER%"

if errorlevel 1 (
  echo.
  echo [FAIL] Installer returned an error.
  echo        If it reports the file is in use, close EVERY Claude Code session
  echo        - including the VS Code extension - then run this again.
  exit /b 1
)

echo.
echo [OK] Rebuilt. Verify with:  claude --version
echo      A version number means fixed. Silence means it did not take.

endlocal
