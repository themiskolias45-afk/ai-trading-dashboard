# Re-run all three RSI-ceiling walk-forward bases, in sequence, logging as it goes.
# Runs ON the box it is launched on. Read-only with respect to trading: it replays
# history through generateSignalMTF and writes only tasks/analysis artifacts.
# Callers back those up first - this script does not, on purpose, so the backup
# decision stays with the caller who knows what is already there.
$ErrorActionPreference = 'Continue'
$proj = 'C:\ai-trading-dashboard'
$log  = Join-Path $proj 'tasks\logs\ceiling_rerun_all.txt'
Set-Location $proj

function Say([string]$m) {
  $line = ((Get-Date).ToUniversalTime().ToString('HH:mm:ss') + 'Z  ' + $m)
  Add-Content -Path $log -Value $line -Encoding utf8
}

Set-Content -Path $log -Value ('START ' + (Get-Date).ToUniversalTime().ToString('s') + 'Z  on ' + $env:COMPUTERNAME) -Encoding utf8

$runs = @(
  @{ name = 'flat';     cost = 'flat';     fold = 'count' },
  @{ name = 'perasset'; cost = 'perasset'; fold = 'count' },
  @{ name = 'time';     cost = 'flat';     fold = 'time'  }
)

foreach ($r in $runs) {
  $env:RSI_CEILING_COST      = $r.cost
  $env:RSI_CEILING_FOLD_MODE = $r.fold
  Say ('RUN ' + $r.name + '  cost=' + $r.cost + ' folds=' + $r.fold)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & node 'tasks\rsi_ceiling_walkforward.cjs' 2>&1
  $sw.Stop()
  $code = $LASTEXITCODE
  Say ('DONE ' + $r.name + '  exit=' + $code + '  elapsed=' + [math]::Round($sw.Elapsed.TotalSeconds,1) + 's')
  if ($code -ne 0) {
    Say ('  *** NON-ZERO EXIT - output tail follows ***')
    $out | Select-Object -Last 25 | ForEach-Object { Say ('  | ' + $_) }
  }
}
Say 'ALLDONE'
