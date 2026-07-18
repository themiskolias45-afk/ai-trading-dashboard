@echo off
title SmartEntry Pro — Install Startup
cd /d "C:\Users\User\ai-trading-dashboard"

echo Creating Windows startup shortcut...

REM Create a VBScript shortcut in the Startup folder so launch_auto.bat runs on login
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set TARGET=C:\Users\User\ai-trading-dashboard\launch_auto.bat
set SHORTCUT=%STARTUP%\SmartEntry Pro.lnk

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%TARGET%'; $s.WorkingDirectory = 'C:\Users\User\ai-trading-dashboard'; $s.Description = 'SmartEntry Pro Auto Launch'; $s.Save()"

echo.
echo  Done! SmartEntry Pro will now start automatically every time you log in to Windows.
echo  Shortcut placed at: %SHORTCUT%
echo.
echo  To remove auto-start later, delete that shortcut.
echo.
pause
