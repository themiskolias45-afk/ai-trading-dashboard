@echo off
title Switch JARVIS to claude.ai Pro
echo.
echo  Switching JARVIS to claude.ai Pro (free sessions)...
echo.

REM Remove ANTHROPIC_API_KEY from user environment
reg delete "HKCU\Environment" /v ANTHROPIC_API_KEY /f >nul 2>&1
echo  [1/2] API key removed from environment.

echo  [2/2] Now open JARVIS.bat and type:  /logout
echo.
echo  After logout, restart JARVIS.bat and log in with your claude.ai account.
echo  JARVIS sessions will be FREE under your Pro subscription.
echo.
echo  NOTE: The trading server still works - it uses server\apikey.txt directly.
echo.
pause
