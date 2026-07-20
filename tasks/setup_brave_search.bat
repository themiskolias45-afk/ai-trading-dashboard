@echo off
title Setup Brave Search for JARVIS
echo.
echo  BRAVE SEARCH SETUP
echo  Gives JARVIS real-time web search — research strategies, news, anything.
echo  Free: 2000 searches/month at https://brave.com/search/api
echo.
echo  Step 1: Go to https://brave.com/search/api
echo  Step 2: Create free account
echo  Step 3: Copy your API key
echo  Step 4: Paste it below
echo.

set /p BRAVE_KEY="Paste your Brave API key here: "

if "%BRAVE_KEY%"=="" (
  echo  No key entered. Exiting.
  pause
  exit /b 1
)

REM Add key to environment for current user
setx BRAVE_API_KEY "%BRAVE_KEY%" >nul 2>&1

REM Update .claude/settings.json to add brave-search MCP
powershell -Command ^
  "$s = Get-Content '.claude\settings.json' -Raw | ConvertFrom-Json; ^
   if (-not $s.mcpServers) { $s | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) }; ^
   $s.mcpServers | Add-Member -NotePropertyName 'brave-search' -NotePropertyValue ([PSCustomObject]@{ command='npx'; args=@('-y','@modelcontextprotocol/server-brave-search'); env=@{ BRAVE_API_KEY='%BRAVE_KEY%' } }) -Force; ^
   $s | ConvertTo-Json -Depth 10 | Set-Content '.claude\settings.json'"

echo.
echo  Done. Brave Search activated.
echo  Restart JARVIS.bat — then JARVIS can search the web in real time.
echo.
echo  Try in JARVIS: /research  — it will now search live web results.
echo.
pause
