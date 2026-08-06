# Toggles MetaTrader 5's AutoTrading (Algo Trading) button via Ctrl+E.
#
# Must run in the INTERACTIVE desktop session - SendKeys posts to the focused
# window of a real desktop, and an SSH/service session has none. Registered as a
# scheduled task with /IT so it lands in the logged-on Administrator session
# where terminal64.exe actually has a window.
#
# Ctrl+E is a toggle, not a set. The caller verifies terminal_info().trade_allowed
# afterwards rather than assuming - a second press would switch it back off.

$ErrorActionPreference = 'Continue'
$log = 'C:\ai-trading-dashboard\tasks\logs\enable_algo.txt'

function Note($m) {
    Add-Content -Path $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m)
}

$proc = Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Note 'terminal64.exe not running - nothing to toggle'; exit 1 }

Note ("terminal64 PID " + $proc.Id + " session " + $proc.SessionId + " hwnd " + $proc.MainWindowHandle)

if ($proc.MainWindowHandle -eq 0) {
    Note 'MainWindowHandle is 0 - no window in this session, SendKeys cannot reach it'
    exit 2
}

Add-Type -AssemblyName System.Windows.Forms

$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate($proc.Id)
Note ("AppActivate returned " + $activated)
Start-Sleep -Milliseconds 800

if (-not $activated) { Note 'could not focus the terminal window'; exit 3 }

[System.Windows.Forms.SendKeys]::SendWait('^e')
Start-Sleep -Milliseconds 500
Note 'sent Ctrl+E'
exit 0
