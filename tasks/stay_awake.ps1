# Keep this box awake WHILE THE TRADING STACK IS UP - and only then.
#
#   powershell -File tasks\stay_awake.ps1            # run it
#   powershell -File tasks\stay_awake.ps1 -Once      # assert, report, exit (for testing)
#
# ASCII ONLY - PS 5.1 reads a BOM-less .ps1 as ANSI.
#
# WHY THIS EXISTS. Measured over ~112 days: this laptop was asleep 58.7% of the time, and
# across 200 hibernation episodes there were ZERO timer wakes. Nothing wakes it, so
# WakeToRun cannot help and every scheduled job simply does not run. In the last 48 hours
# alone there were 3 holes totalling 34.8h, the worst 22.3h, after which 7 components had
# to be restarted. A trading stack that is asleep is not a trading stack.
#
# WHY NOT `powercfg /requestsoverride PROCESS node.exe SYSTEM`. That is Option A in
# tasks\SLEEP-RUNBOOK.md and it works, but it needs ELEVATION and it is not specific: there
# were 66 node.exe processes on this box when measured - MCP servers, npx launches,
# tooling - so it keeps the machine awake whenever ANY node runs. The runbook itself says
# a narrower fix needs a dedicated holder. This is that holder.
#
# HOW. SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) is a per-process request
# that needs NO administrator rights. It keeps the SYSTEM awake and deliberately does NOT
# pass ES_DISPLAY_REQUIRED, so the screen still sleeps normally.
#
# IT IS CONDITIONAL, ON PURPOSE. The request is held only while the server actually answers
# on 3001. Stop the stack and this releases within a minute and lets the box sleep, so
# "keep the trading system alive" never turns into "this laptop never sleeps again".
#
# IT CHANGES NOTHING ELSE. No registry, no power plan, no scheduled task, no trading state.
# The request dies with the process - closing this window undoes it completely.

param([switch]$Once)

$ErrorActionPreference = 'Continue'

$log = Join-Path $PSScriptRoot 'logs\stay_awake.txt'
$dir = Split-Path -Parent $log
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

function Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $line
}

# Compiled once. Re-adding the type on every loop throws "type already exists".
if (-not ([System.Management.Automation.PSTypeName]'SmartEntry.Power').Type) {
    Add-Type -Namespace SmartEntry -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
}

# DECIMAL, not 0x80000000. PowerShell 5.1 parses that hex literal as a SIGNED Int32,
# yielding -2147483648, and the cast to [uint32] then throws "Value was either too large
# or too small". Written as a decimal literal it is an Int64 and converts cleanly.
$ES_CONTINUOUS       = [uint32]2147483648   # 0x80000000
$ES_SYSTEM_REQUIRED  = [uint32]1            # 0x00000001
# No ES_DISPLAY_REQUIRED: the screen should still be allowed to sleep.
$HOLD    = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
$RELEASE = $ES_CONTINUOUS

function ServerIsUp {
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:3001/api/status' -TimeoutSec 4 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        # A 302 to /login still proves the server is answering. Only a connection failure
        # means it is down, and treating a redirect as "down" would release the hold on a
        # perfectly healthy box.
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        return ($code -ne $null -and $code -gt 0)
    }
}

Log '--- stay_awake start ---'
$holding = $false

try {
    do {
        $up = ServerIsUp
        if ($up -and -not $holding) {
            $prev = [SmartEntry.Power]::SetThreadExecutionState($HOLD)
            if ($prev -eq 0) { Log 'SetThreadExecutionState FAILED - the box may still sleep' }
            else { Log 'HOLDING system-required: the box will not sleep while the server answers' }
            $holding = $true
        } elseif (-not $up -and $holding) {
            [void][SmartEntry.Power]::SetThreadExecutionState($RELEASE)
            Log 'released - the server is not answering, so this box may sleep again'
            $holding = $false
        }
        if ($Once) { break }
        Start-Sleep -Seconds 60
    } while ($true)
}
finally {
    # Always let go. A holder that dies still holding would keep the machine awake with
    # nothing left to explain why, which is worse than the sleeping it was meant to fix.
    if ($holding) { [void][SmartEntry.Power]::SetThreadExecutionState($RELEASE) }
    Log '--- stay_awake stop (request released) ---'
}
