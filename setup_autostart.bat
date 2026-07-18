@echo off
title SmartEntry Pro — Setup Auto-Start

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP%\SmartEntry.bat

echo.
echo  Setting up SmartEntry Pro to start automatically on Windows login...
echo.

REM Write a launcher into the Windows Startup folder
(
echo @echo off
echo cd /d "%~dp0"
echo call "%~dp0START.bat"
) > "%SHORTCUT%"

if exist "%SHORTCUT%" (
  echo  [OK] Auto-start configured.
  echo.
  echo  SmartEntry Pro will now start automatically every time you log in to Windows.
  echo  Shortcut saved to: %SHORTCUT%
  echo.
  echo  To REMOVE auto-start, delete the file above.
) else (
  echo  [ERROR] Could not create shortcut. Try running as Administrator.
)

echo.
pause
