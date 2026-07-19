@echo off
title SmartEntry Pro - Install Scheduled Tasks
cd /d "C:\Users\User\ai-trading-dashboard"
echo.
echo  ==========================================
echo   Installing Scheduled Tasks...
echo  ==========================================
echo.

REM Daily morning check - Mon to Fri at 07:30
schtasks /create /tn "SmartEntry - Daily Check" ^
  /tr "C:\Users\User\ai-trading-dashboard\tasks\auto_daily.bat" ^
  /sc WEEKLY /d MON,TUE,WED,THU,FRI /st 07:30 /f
echo  [OK] Daily check scheduled: Mon-Fri at 07:30

REM Signal scan every 4 hours during trading hours
schtasks /create /tn "SmartEntry - Signal Scan 09:00" ^
  /tr "C:\Users\User\ai-trading-dashboard\tasks\auto_signal.bat" ^
  /sc WEEKLY /d MON,TUE,WED,THU,FRI /st 09:00 /f
echo  [OK] Signal scan at 09:00

schtasks /create /tn "SmartEntry - Signal Scan 13:00" ^
  /tr "C:\Users\User\ai-trading-dashboard\tasks\auto_signal.bat" ^
  /sc WEEKLY /d MON,TUE,WED,THU,FRI /st 13:00 /f
echo  [OK] Signal scan at 13:00

schtasks /create /tn "SmartEntry - Signal Scan 17:00" ^
  /tr "C:\Users\User\ai-trading-dashboard\tasks\auto_signal.bat" ^
  /sc WEEKLY /d MON,TUE,WED,THU,FRI /st 17:00 /f
echo  [OK] Signal scan at 17:00

REM Weekly algorithm review - Sunday at 10:00
schtasks /create /tn "SmartEntry - Weekly Algo Review" ^
  /tr "C:\Users\User\ai-trading-dashboard\tasks\auto_weekly.bat" ^
  /sc WEEKLY /d SUN /st 10:00 /f
echo  [OK] Weekly algo review: Sunday at 10:00

echo.
echo  ==========================================
echo   All tasks installed. View in Task Scheduler.
echo   To remove: schtasks /delete /tn "SmartEntry - Daily Check" /f
echo  ==========================================
echo.
pause
