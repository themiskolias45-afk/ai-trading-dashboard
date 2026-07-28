# Runs the daily task cycle once per calendar day.
# Invokes JARVIS /daily via claude -p so the full AI analysis runs automatically.
# Uses a date-stamped flag file so it never runs twice on the same day.
# Runs async at session start — does not block the JARVIS welcome.

$proj  = 'C:\Users\User\ai-trading-dashboard'
$today = Get-Date -Format 'yyyyMMdd'
$flag  = "$proj\tasks\.daily_ran_$today"

# Already ran today — skip
if (Test-Path $flag) { exit 0 }

# Mark as ran immediately (prevents concurrent runs if two sessions open fast)
New-Item $flag -Force | Out-Null

# Cleanup flags older than 7 days
Get-ChildItem "$proj\tasks\" -Filter '.daily_ran_*' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

# Run /daily in background — results go to a log file for reference
$logFile = "$proj\tasks\logs\daily_runner_$today.txt"
$null = New-Item -ItemType Directory -Force "$proj\tasks\logs" -ErrorAction SilentlyContinue

$prompt = @"
Run the full /daily task cycle. This is the automated daily check — run every step without asking for permission. After the daily report, stop and wait.
"@

Start-Process -FilePath 'claude' `
    -ArgumentList "-p `"$prompt`" --dangerously-skip-permissions" `
    -WorkingDirectory $proj `
    -RedirectStandardOutput $logFile `
    -NoNewWindow `
    -ErrorAction SilentlyContinue
