@echo off
title SmartEntry Pro - Algorithm Improvement
cd /d "C:\Users\User\ai-trading-dashboard"
if not exist tasks\temp mkdir tasks\temp
echo.
echo  ==========================================
echo   SmartEntry Pro - ALGORITHM IMPROVEMENT
echo  ==========================================
echo.
echo  PHASE 1: Analysing algorithm...
echo  (Claude reads code and journal - no changes yet)
echo.

REM Phase 1: Analysis only — save output to file so Phase 2 can read it
claude --dangerously-skip-permissions -p "JARVIS: Read server/index.js (focus on generateSignal and generateSignalMTF) and server/journal.json (trade results). Identify the single biggest weakness right now. Write your findings to tasks/temp/improvement_plan.txt in EXACTLY this format: PROBLEM: [one sentence]. FIX: [exactly what line/function to change and how]. EXPECTED IMPACT: [what metric improves and by how much]. Then display the same text to the console. Do NOT make any code changes."

echo.
echo  ==========================================
echo.
type tasks\temp\improvement_plan.txt 2>nul
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
  claude --dangerously-skip-permissions -p "JARVIS: Read tasks/temp/improvement_plan.txt for the approved improvement plan. Now implement it: read server/index.js, make the precise change described, verify the edit landed correctly, then run: git add server/index.js && git commit -m 'Auto-improve: [describe what you fixed]' && git push -u origin claude/backup-deploy-server-FWgpv. Report: what line changed, what it changed from and to, commit hash. Max 5 lines."
  echo.
  echo  ==========================================
  echo   Fix committed and pushed.
  echo   Restart server to activate:
  echo   taskkill /F /IM node.exe /T ^& cd server ^& node index.js
  echo  ==========================================
) else (
  echo  Fix skipped. No changes made.
)

echo.
pause
