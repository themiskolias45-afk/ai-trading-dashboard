@echo off
title SmartEntry Pro - Algorithm Improvement
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   SmartEntry Pro - ALGORITHM IMPROVEMENT
echo  ==========================================
echo.
echo  PHASE 1: Analysing algorithm...
echo  (Claude reads code and journal - no changes yet)
echo.

REM Phase 1: Analysis only - Claude reads and proposes, does NOT touch code
claude --dangerously-skip-permissions -p "JARVIS: Read server/index.js (signal engine, focus on generateSignal and generateSignalMTF functions) and server/journal.json (trade results). Identify the single biggest weakness right now. Output EXACTLY this format: PROBLEM: [one sentence]. FIX: [exactly what line/function to change and how]. EXPECTED IMPACT: [what metric improves and by how much]. Do NOT make any code changes."

echo.
echo  ==========================================
echo   APPROVAL REQUIRED
echo  ==========================================
echo.
set /p APPROVE=" Approve this fix? (Y/N): "
echo.

if /i "%APPROVE%"=="Y" (
  echo  Implementing fix...
  echo.
  claude --dangerously-skip-permissions -p "JARVIS: Implement the improvement you just identified in the analysis above. Read server/index.js, make the precise change described, verify the edit landed correctly, then run: git add server/index.js && git commit -m 'Auto-improve: [describe what you fixed]' and git push -u origin claude/backup-deploy-server-FWgpv. Report: what line changed, what it changed from and to, commit hash. Max 5 lines."
  echo.
  echo  Fix committed and pushed. Restart the server to activate.
  echo  cd C:\Users\User\ai-trading-dashboard\server
  echo  taskkill /F /IM node.exe /T ^& node index.js
) else (
  echo  Fix skipped. No changes made.
)

echo.
pause
