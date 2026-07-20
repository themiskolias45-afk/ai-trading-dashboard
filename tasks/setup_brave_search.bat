@echo off
title Setup Brave Search for JARVIS
echo.
echo  BRAVE SEARCH SETUP
echo  Free: 2000 searches/month at https://brave.com/search/api
echo.
echo  Step 1: Go to https://brave.com/search/api
echo  Step 2: Create free account and copy your API key
echo  Step 3: Paste it below (key is stored as a Windows env variable - never committed to git)
echo.

set /p BRAVE_KEY="Paste your Brave API key: "

if "%BRAVE_KEY%"=="" (
  echo  No key entered. Exiting.
  pause
  exit /b 1
)

REM Store key as permanent user environment variable only - never written to any file
setx BRAVE_API_KEY "%BRAVE_KEY%" >nul 2>&1
echo  [1/2] API key saved to Windows environment (not in any file).

REM Add brave-search MCP server to settings.json - NO key in the file, reads from env
powershell -Command "$f='.claude\settings.json'; $s=Get-Content $f -Raw | ConvertFrom-Json; if(-not $s.mcpServers.'brave-search'){$s.mcpServers | Add-Member -NotePropertyName 'brave-search' -NotePropertyValue ([PSCustomObject]@{command='npx';args=@('-y','@modelcontextprotocol/server-brave-search')}) -Force}; $s | ConvertTo-Json -Depth 10 | Set-Content $f"
echo  [2/2] Brave Search added to JARVIS config (key reads from Windows env, not stored in file).

echo.
echo  Done. Restart JARVIS.bat to activate web search.
echo  Try: /research  -- JARVIS will now search the live web.
echo.
pause
