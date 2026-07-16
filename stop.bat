@echo off
title SmartEntry Pro — Stopping...
echo.
echo  Stopping SmartEntry Pro...
echo.

taskkill /F /IM node.exe   /T 2>nul && echo  [OK] Server stopped    || echo  [--] Server was not running
taskkill /F /IM python.exe /T 2>nul && echo  [OK] MT5 bridge stopped || echo  [--] MT5 bridge was not running

echo.
echo  SmartEntry stopped. Run run_all.bat to start again.
echo.
pause
