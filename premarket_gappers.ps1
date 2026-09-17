<#
    PREMARKET GAPPERS SCANNER - one script, both boxes.

    READ-ONLY, AND DELIBERATELY SO. It places no order, touches no journal, no
    learning record, no calibration record, no gate and no setting. It writes
    nothing anywhere unless you pass -JsonOut, and then only to the path you name.
    Nothing in SmartEntry reads its output. It is a screening tool: a list of names
    to look at, never a signal and never a fill.

    WHY POWERSHELL AND NOT sh. Measured 2026-09-17: the VPS has curl, python and
    node but NO bash - `where bash` returns "Could not find files for the given
    pattern(s)". The laptop has bash via Git. So the only shell BOTH boxes actually
    share is PowerShell, and a .sh here would have run on one machine and silently
    been undeployable on the one that trades.

    WRITTEN FOR POWERSHELL 5.1, which is what these boxes run:
      - no ternary, no ?? , no && / || (all are parse errors in 5.1)
      - ConvertFrom-Json returns PSCustomObject, never a hashtable
      - TLS 1.2 is forced below; 5.1 can still default to TLS 1.0 and Yahoo refuses it
      - PURE ASCII on purpose. This repo has lost a whole agent fleet to one
        non-ASCII character in a script, and PS 5.1 re-encodes carelessly.

    DATA SOURCE: Yahoo's chart endpoint, the same one tasks/fetch_yahoo_history.cjs
    already uses (query1.finance.yahoo.com/v8/finance/chart). No API key, no
    account, no secret - so there is nothing here to leak.

    HOW THE GAP IS COMPUTED, and what it is not:
      gap% = (last premarket print - previous regular close) / previous close * 100
    The previous close is Yahoo's chartPreviousClose. The premarket print is the
    last 1-minute bar whose timestamp falls BEFORE the regular session start, taken
    from the meta.currentTradingPeriod windows rather than assumed from the clock -
    those windows move with DST and with the exchange, and hardcoding 09:30 ET is
    how a scanner quietly reports nothing for half the year.

    USAGE
      .\premarket_gappers.ps1
      .\premarket_gappers.ps1 -MinGapPercent 4 -MinPrice 10
      .\premarket_gappers.ps1 -Symbols NVDA,AMD,TSLA
      .\premarket_gappers.ps1 -FromHistory
      .\premarket_gappers.ps1 -JsonOut "$env:TEMP\gappers.json"

    EXIT CODES
      0  scan completed (even if nothing passed the filter - an empty market is an
         answer, not a failure)
      1  every symbol failed to fetch, so the run says nothing about the market
      2  bad arguments
#>

[CmdletBinding()]
param(
    # Symbols to scan. Omit for the built-in liquid US list.
    [string[]] $Symbols,

    # Use the tickers already on disk in tasks/history_yahoo instead of the built-in list.
    [switch] $FromHistory,

    # Report a name when the absolute gap is at least this many percent.
    [double] $MinGapPercent = 2.0,

    # Ignore anything trading below this, where a percent move is noise.
    [double] $MinPrice = 5.0,

    # Ignore names with less premarket volume than this. 0 disables the filter.
    [double] $MinPremarketVolume = 0,

    # Write the full result set here as JSON. The ONLY thing this script can write.
    [string] $JsonOut = "",

    # Seconds to wait between requests. Yahoo rate-limits; do not set this to 0.
    [double] $ThrottleSeconds = 0.35,

    # Per-request timeout.
    [int] $TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

if ($MinGapPercent -lt 0)      { Write-Output "MinGapPercent must be >= 0";      exit 2 }
if ($MinPrice -lt 0)           { Write-Output "MinPrice must be >= 0";           exit 2 }
if ($ThrottleSeconds -lt 0)    { Write-Output "ThrottleSeconds must be >= 0";    exit 2 }

# PS 5.1 can still negotiate TLS 1.0, which Yahoo refuses. Without this the whole
# scan fails on the VPS with an unhelpful "could not create SSL/TLS secure channel".
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Write-Output "NOTE: could not raise TLS to 1.2 - fetches may fail on this host."
}

# A plain browser UA. Yahoo serves this endpoint without one, but rate-limits harder.
$Headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }

# Built-in universe: liquid US names and ETFs where a premarket gap is tradeable at
# all. Deliberately short - a scanner over 500 thin tickers reports noise and takes
# three minutes doing it.
$DefaultUniverse = @(
    'AAPL','MSFT','NVDA','AMD','AMZN','GOOGL','META','TSLA','AVGO','NFLX',
    'INTC','MU','PLTR','COIN','MSTR','SMCI','BA','DIS','JPM','BAC',
    'PFE','XOM','WMT','SPY','QQQ','IWM','GLD','TLT','SOXL','ARKK'
)

function Get-Universe {
    if ($Symbols -and $Symbols.Count -gt 0) {
        # SPLIT ON COMMAS TOO, and this is not belt-and-braces.
        #
        # Invoked as `powershell -File .\premarket_gappers.ps1 -Symbols NVDA,AMD,TSLA`
        # PowerShell passes the whole list as ONE string - -File binds arguments as
        # plain strings and does no array splitting. Measured: the scan then requested
        # a symbol literally named "NVDA,AMD,TSLA,AAPL,SPY" and took a 404. Only the
        # dot-sourced / -Command form binds a real array, and -File is how a scheduled
        # task would ever call this.
        return ($Symbols |
            ForEach-Object { $_ -split ',' } |
            ForEach-Object { $_.Trim().ToUpper() } |
            Where-Object { $_ })
    }
    if ($FromHistory) {
        $dir = Join-Path $PSScriptRoot 'tasks\history_yahoo'
        if (-not (Test-Path $dir)) {
            Write-Output "-FromHistory: $dir does not exist. Falling back to the built-in list."
            return $DefaultUniverse
        }
        # Strip the _D1/_H1/_H4/_M15 suffix, drop the Y-prefixed Yahoo-only rows and
        # anything that is plainly not a US equity or ETF (FX pairs, metals, indices).
        $names = Get-ChildItem $dir -Filter '*.csv' -ErrorAction SilentlyContinue |
            ForEach-Object { ($_.BaseName -replace '_(D1|H1|H4|M15)$', '') } |
            Where-Object { $_ -notmatch '^(XAU|XAG|BTC|ETH|LTC|EUR|GBP|AUD|USD|SP500|NAS100|zBASE)' } |
            Where-Object { $_ -cmatch '^[A-Z\.]{1,6}$' } |
            Sort-Object -Unique
        if (-not $names -or $names.Count -eq 0) {
            Write-Output "-FromHistory: no usable tickers found. Falling back to the built-in list."
            return $DefaultUniverse
        }
        return $names
    }
    return $DefaultUniverse
}

function Get-SymbolQuote {
    param([string] $Symbol)

    $url = "https://query1.finance.yahoo.com/v8/finance/chart/$([uri]::EscapeDataString($Symbol))" +
           "?range=1d&interval=1m&includePrePost=true"

    $raw = $null
    try {
        $raw = Invoke-RestMethod -Uri $url -Headers $Headers -TimeoutSec $TimeoutSeconds -UseBasicParsing
    } catch {
        return [pscustomobject]@{ symbol = $Symbol; ok = $false; error = $_.Exception.Message }
    }

    $result = $null
    if ($raw -and $raw.chart -and $raw.chart.result) { $result = $raw.chart.result[0] }
    if (-not $result) {
        $msg = 'no result block'
        if ($raw -and $raw.chart -and $raw.chart.error) { $msg = [string]$raw.chart.error.description }
        return [pscustomobject]@{ symbol = $Symbol; ok = $false; error = $msg }
    }

    $meta = $result.meta
    $prevClose = $meta.chartPreviousClose
    if ($null -eq $prevClose -or $prevClose -le 0) {
        return [pscustomobject]@{ symbol = $Symbol; ok = $false; error = 'no previous close' }
    }

    # Session windows from the payload, never from the local clock. These move with
    # DST and differ per exchange.
    $regularStart = $null
    if ($meta.currentTradingPeriod -and $meta.currentTradingPeriod.regular) {
        $regularStart = $meta.currentTradingPeriod.regular.start
    }
    if ($null -eq $regularStart) {
        return [pscustomobject]@{ symbol = $Symbol; ok = $false; error = 'no regular session window' }
    }

    $stamps = @($result.timestamp)
    $closes = @()
    $vols   = @()
    if ($result.indicators -and $result.indicators.quote) {
        $closes = @($result.indicators.quote[0].close)
        $vols   = @($result.indicators.quote[0].volume)
    }

    $lastPre = $null; $lastPreAt = $null; $preVol = 0.0; $preBars = 0
    for ($i = 0; $i -lt $stamps.Count; $i++) {
        if ($i -ge $closes.Count) { break }
        $t = $stamps[$i]
        $c = $closes[$i]
        if ($null -eq $c) { continue }
        if ($t -ge $regularStart) { continue }   # regular or post, not premarket
        $lastPre = [double]$c
        $lastPreAt = $t
        $preBars++
        if ($i -lt $vols.Count -and $null -ne $vols[$i]) { $preVol += [double]$vols[$i] }
    }

    if ($null -eq $lastPre) {
        # Not an error. Outside premarket hours, on a weekend, or a name with no
        # premarket trade at all - all three are legitimate and must not read as a
        # failed fetch.
        return [pscustomobject]@{
            symbol = $Symbol; ok = $true; hasPremarket = $false
            prevClose = [double]$prevClose; error = $null
        }
    }

    $gapPct = (($lastPre - $prevClose) / $prevClose) * 100.0

    return [pscustomobject]@{
        symbol          = $Symbol
        ok              = $true
        hasPremarket    = $true
        prevClose       = [math]::Round([double]$prevClose, 4)
        premarketPrice  = [math]::Round($lastPre, 4)
        gapPercent      = [math]::Round($gapPct, 2)
        direction       = $(if ($gapPct -ge 0) { 'UP' } else { 'DOWN' })
        premarketVolume = [long]$preVol
        premarketBars   = $preBars
        lastPrintUtc    = [DateTimeOffset]::FromUnixTimeSeconds([long]$lastPreAt).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
        error           = $null
    }
}

# ---------------------------------------------------------------- run

$universe = Get-Universe
$nowUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

Write-Output ""
Write-Output "PREMARKET GAPPERS - read-only screen, places no orders"
Write-Output ("  as of {0}   symbols {1}   filters: |gap| >= {2}%, price >= {3}, preVol >= {4}" -f `
    $nowUtc, $universe.Count, $MinGapPercent, $MinPrice, $MinPremarketVolume)
Write-Output ""

$all = New-Object System.Collections.ArrayList
$failed = 0
$i = 0
foreach ($sym in $universe) {
    $i++
    Write-Progress -Activity 'Scanning premarket' -Status "$sym ($i of $($universe.Count))" `
        -PercentComplete (($i / [math]::Max(1, $universe.Count)) * 100)
    $q = Get-SymbolQuote -Symbol $sym
    if (-not $q.ok) { $failed++ }
    [void]$all.Add($q)
    if ($ThrottleSeconds -gt 0 -and $i -lt $universe.Count) { Start-Sleep -Milliseconds ([int]($ThrottleSeconds * 1000)) }
}
Write-Progress -Activity 'Scanning premarket' -Completed

# EVERY fetch failed means this run says nothing about the market. That is a
# different outcome from "the market is quiet" and must not exit 0.
if ($failed -eq $universe.Count -and $universe.Count -gt 0) {
    Write-Output "ALL $failed symbol(s) failed to fetch - this run says NOTHING about the market."
    $all | Where-Object { -not $_.ok } | Select-Object -First 3 |
        ForEach-Object { Write-Output ("   {0}: {1}" -f $_.symbol, $_.error) }
    exit 1
}

$withPre = @($all | Where-Object { $_.ok -and $_.hasPremarket })
$hits = @($withPre | Where-Object {
    [math]::Abs($_.gapPercent) -ge $MinGapPercent -and
    $_.premarketPrice -ge $MinPrice -and
    $_.premarketVolume -ge $MinPremarketVolume
} | Sort-Object { - [math]::Abs($_.gapPercent) })

if ($hits.Count -gt 0) {
    Write-Output ("{0,-8} {1,>8} {2,>10} {3,>9} {4,>6} {5,>12}  {6}" -f `
        'SYMBOL','GAP %','PREMARKET','PREVCLOSE','DIR','PRE VOL','LAST PRINT (UTC)')
    Write-Output ('-' * 78)
    foreach ($h in $hits) {
        Write-Output ("{0,-8} {1,8:+0.00;-0.00} {2,10:N2} {3,9:N2} {4,6} {5,12:N0}  {6}" -f `
            $h.symbol, $h.gapPercent, $h.premarketPrice, $h.prevClose, $h.direction,
            $h.premarketVolume, $h.lastPrintUtc)
    }
} else {
    Write-Output "No symbol passed the filter."
}

$noPre = @($all | Where-Object { $_.ok -and -not $_.hasPremarket }).Count
Write-Output ""
Write-Output ("scanned {0} | with premarket trade {1} | passed filter {2} | no premarket {3} | fetch failed {4}" -f `
    $all.Count, $withPre.Count, $hits.Count, $noPre, $failed)
if ($noPre -eq $withPre.Count -and $withPre.Count -eq 0) {
    Write-Output "  (no premarket prints anywhere - outside premarket hours, or a weekend)"
}
if ($failed -gt 0) {
    Write-Output "  ($failed symbol(s) could not be fetched and are NOT represented above)"
}
Write-Output ""
Write-Output "SCREEN ONLY. Not a signal, not a setup, and nothing in SmartEntry reads this."

if ($JsonOut) {
    try {
        $payload = [pscustomobject]@{
            generatedAt = $nowUtc
            filters     = [pscustomobject]@{
                minGapPercent = $MinGapPercent; minPrice = $MinPrice
                minPremarketVolume = $MinPremarketVolume
            }
            scanned     = $all.Count
            failed      = $failed
            feedsTheGate = $false
            results     = $all
        }
        $dir = Split-Path -Parent $JsonOut
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $payload | ConvertTo-Json -Depth 6 | Out-File -FilePath $JsonOut -Encoding utf8
        Write-Output "wrote $JsonOut"
    } catch {
        # A failed report write must not fail the scan that already succeeded.
        Write-Output ("could not write {0}: {1}" -f $JsonOut, $_.Exception.Message)
    }
}

exit 0
