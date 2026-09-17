<#
    PREMARKET GAPPERS SCANNER.

    READ-ONLY, AND DELIBERATELY SO. It places no order, touches no journal, no
    learning record, no calibration record, no gate and no setting. It writes
    nothing unless you pass -JsonOut. Nothing in SmartEntry reads its output. It is
    a screening tool: a list of names to look at, never a signal and never a fill.

    REWRITTEN 2026-09-17 because the first version did not really work, for two
    reasons that both mattered:

    1. NO VOLUME. It reported premarket volume as n/a, honestly, because Yahoo's
       chart endpoint returns a literal 0 for every premarket bar - measured at 1m
       (328 bars, all zero) AND at 5m (66 bars, all zero). A gap without volume is
       not a tradeable fact: +10% on 500 shares is noise and +10% on 2,000,000 is a
       setup, and the old scanner could not tell those apart. It therefore could not
       do the one job a gappers screen exists to do.
       FIXED: premarket price, VOLUME, high and low now come from Nasdaq's own
       extended-trading endpoint, which publishes "Pre-Market Share Volume"
       directly. No API key. Measured 2026-09-17: NVDA 3,820,575 shares.

    2. A FIXED UNIVERSE OF 30 NAMES I CHOSE. A real gapper is a name you do not
       already know - it gaps on news overnight. Checking thirty large caps I picked
       can only ever tell you whether the names I picked moved.
       FIXED: the universe is DISCOVERED from Yahoo's day_gainers screener (261
       candidates available, returning names like SDGR, BHVN, TEM, OKLO) and only
       then priced. -Symbols still overrides it for a targeted check.

    WHY TWO SOURCES, and which is authoritative. Nasdaq is primary: it is the
    consolidated tape for the premarket session and it is the only one of the two
    that reports volume. Yahoo's chart is the FALLBACK for a symbol Nasdaq does not
    answer for, and a gap priced from the fallback is labelled as such in the output
    rather than quietly mixed in - the two disagree slightly (AMD +4.55% Nasdaq vs
    +4.13% Yahoo on the same morning) because they timestamp the last print
    differently, and an unlabelled blend of the two would be a number with no
    provenance.

    WRITTEN FOR POWERSHELL 5.1, which is what both boxes run:
      - no ternary, no ?? , no && / || (all parse errors in 5.1)
      - ConvertFrom-Json returns PSCustomObject, never a hashtable
      - TLS 1.2 forced; 5.1 can still default to TLS 1.0 and both hosts refuse it
      - PURE ASCII. This repo has lost an agent fleet to one non-ASCII character.

    ONE SCRIPT, NOT TWO. A POSIX .sh version existed and was removed: the VPS has no
    bash (`where bash` returns nothing), so it could never run on the box that
    trades. It is recoverable with `git show 24676c9:premarket_gappers.sh`.

    USAGE
      .\premarket_gappers.ps1                          discover gappers, |gap| >= 2%
      .\premarket_gappers.ps1 -MinGapPercent 5 -MinPremarketVolume 100000
      .\premarket_gappers.ps1 -Symbols NVDA,AMD        check these instead
      .\premarket_gappers.ps1 -Discover 50             widen the discovery set
      .\premarket_gappers.ps1 -JsonOut "$env:TEMP\g.json"

    EXIT CODES
      0  scan completed (even if nothing passed - an empty market is an answer)
      1  every symbol failed, so the run says nothing about the market
      2  bad arguments
#>

[CmdletBinding()]
param(
    # Explicit symbols. Omit to DISCOVER the universe instead.
    [string[]] $Symbols,

    # How many candidates to pull from the screener when discovering.
    [int] $Discover = 40,

    # Report a name when the absolute premarket gap is at least this many percent.
    [double] $MinGapPercent = 2.0,

    # Ignore anything trading below this, where a percent move is noise.
    [double] $MinPrice = 2.0,

    # Ignore thin premarket tape. THIS FILTER NOW ACTUALLY WORKS - see the header.
    [double] $MinPremarketVolume = 25000,

    [string] $JsonOut = "",
    [double] $ThrottleSeconds = 0.30,
    [int] $TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
if ($MinGapPercent -lt 0)   { Write-Output "MinGapPercent must be >= 0";   exit 2 }
if ($MinPrice -lt 0)        { Write-Output "MinPrice must be >= 0";        exit 2 }
if ($ThrottleSeconds -lt 0) { Write-Output "ThrottleSeconds must be >= 0"; exit 2 }

try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Write-Output "NOTE: could not raise TLS to 1.2 - fetches may fail on this host."
}

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
$YahooHeaders  = @{ 'User-Agent' = $UA }
$NasdaqHeaders = @{ 'User-Agent' = $UA; 'Accept' = 'application/json' }

# Parses "$535.83 +23.33 (+4.55%)" and "801,618". Returns $null on anything it does
# not recognise rather than a zero - a number that could not be read must never be
# reported as a measured value.
function ParseMoney {
    param([string] $s)
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }
    $m = [regex]::Match($s, '\$?\s*(-?[0-9][0-9,]*\.?[0-9]*)')
    if (-not $m.Success) { return $null }
    $v = $m.Groups[1].Value -replace ',', ''
    $out = 0.0
    if ([double]::TryParse($v, [ref]$out)) { return $out }
    return $null
}
function ParseCount {
    param([string] $s)
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }
    $v = ($s -replace '[^0-9]', '')
    if ($v -eq '') { return $null }
    $out = 0.0
    if ([double]::TryParse($v, [ref]$out)) { return $out }
    return $null
}

function Get-Universe {
    if ($Symbols -and $Symbols.Count -gt 0) {
        # -File binds arguments as plain strings and does NO array splitting, so
        # `-Symbols NVDA,AMD` arrives as one string. Measured: the scan requested a
        # ticker literally named "NVDA,AMD,TSLA" and took a 404. -File is how a
        # scheduled task calls this, so the split is not optional.
        return @($Symbols | ForEach-Object { $_ -split ',' } |
                 ForEach-Object { $_.Trim().ToUpper() } | Where-Object { $_ })
    }
    # DISCOVERY. Ask which names are actually moving instead of checking a list I
    # chose. Falls back to a small liquid set only if the screener is unreachable,
    # and says so - a silent fallback would make a broken screener look like a quiet
    # market.
    $url = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved' +
           "?scrIds=day_gainers&count=$Discover"
    try {
        $r = Invoke-RestMethod -Uri $url -Headers $YahooHeaders -TimeoutSec $TimeoutSeconds
        $res = $null
        if ($r -and $r.finance -and $r.finance.result) { $res = $r.finance.result[0] }
        if ($res -and $res.quotes) {
            $syms = @($res.quotes | ForEach-Object { $_.symbol } | Where-Object { $_ })
            if ($syms.Count -gt 0) {
                Write-Output ("  discovered " + $syms.Count + " candidate(s) from the day_gainers screener (" +
                              $res.total + " available)")
                return $syms
            }
        }
        Write-Output "  screener returned no candidates - falling back to a liquid default set"
    } catch {
        Write-Output ("  screener unreachable (" + $_.Exception.Message + ") - falling back to a liquid default set")
    }
    return @('AAPL','MSFT','NVDA','AMD','AMZN','GOOGL','META','TSLA','AVGO','NFLX',
             'INTC','MU','PLTR','COIN','MSTR','SMCI','SPY','QQQ','IWM','SOXL')
}

# PRIMARY SOURCE. Nasdaq's extended-trading endpoint is the consolidated premarket
# tape and the only one of the two that reports volume.
function Get-NasdaqPremarket {
    param([string] $Symbol)
    $url = "https://api.nasdaq.com/api/quote/$([uri]::EscapeDataString($Symbol))/extended-trading" +
           "?assetclass=stocks&markettype=pre"
    try {
        $r = Invoke-RestMethod -Uri $url -Headers $NasdaqHeaders -TimeoutSec $TimeoutSeconds
    } catch {
        return [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
    }
    if (-not $r -or -not $r.data) { return [pscustomobject]@{ ok = $false; error = 'no data block' } }
    $d = $r.data
    $prev = ParseMoney $d.previousInfo
    $rows = $null
    if ($d.infoTable -and $d.infoTable.rows) { $rows = @($d.infoTable.rows) }
    if (-not $rows -or $rows.Count -eq 0 -or $null -eq $prev) {
        # No premarket rows is NOT an error: outside premarket hours, a weekend, or a
        # name with no premarket trade are all legitimate and must not read as failure.
        return [pscustomobject]@{ ok = $true; hasPremarket = $false; prevClose = $prev }
    }
    $row  = $rows[0]
    $last = ParseMoney $row.consolidated
    $vol  = ParseCount $row.volume
    if ($null -eq $last -or $prev -le 0) {
        return [pscustomobject]@{ ok = $true; hasPremarket = $false; prevClose = $prev }
    }
    return [pscustomobject]@{
        ok = $true; hasPremarket = $true; source = 'nasdaq'
        prevClose = $prev; premarketPrice = $last
        premarketVolume = $vol
        premarketHigh = (ParseMoney $row.highPrice); premarketLow = (ParseMoney $row.lowPrice)
        gapPercent = [math]::Round((($last - $prev) / $prev) * 100.0, 2)
    }
}

# FALLBACK ONLY. Yahoo's chart has no premarket volume at any interval, so a row
# priced from here carries volume $null and is LABELLED source=yahoo rather than
# blended in - the two sources timestamp the last print differently and an
# unlabelled mixture would be a number with no provenance.
function Get-YahooPremarket {
    param([string] $Symbol)
    $url = "https://query1.finance.yahoo.com/v8/finance/chart/$([uri]::EscapeDataString($Symbol))" +
           "?range=1d&interval=1m&includePrePost=true"
    try { $raw = Invoke-RestMethod -Uri $url -Headers $YahooHeaders -TimeoutSec $TimeoutSeconds }
    catch { return [pscustomobject]@{ ok = $false; error = $_.Exception.Message } }
    $res = $null
    if ($raw -and $raw.chart -and $raw.chart.result) { $res = $raw.chart.result[0] }
    if (-not $res) { return [pscustomobject]@{ ok = $false; error = 'no result block' } }
    $meta = $res.meta
    $prev = $meta.chartPreviousClose
    if ($null -eq $prev -or $prev -le 0) { return [pscustomobject]@{ ok = $false; error = 'no previous close' } }
    # Session windows from the payload, never the local clock: they move with DST and
    # per exchange, and a hardcoded 09:30 ET reports nothing for half the year.
    $regStart = $null
    if ($meta.currentTradingPeriod -and $meta.currentTradingPeriod.regular) {
        $regStart = $meta.currentTradingPeriod.regular.start
    }
    if ($null -eq $regStart) { return [pscustomobject]@{ ok = $false; error = 'no session window' } }
    $stamps = @($res.timestamp); $closes = @()
    if ($res.indicators -and $res.indicators.quote) { $closes = @($res.indicators.quote[0].close) }
    $last = $null
    for ($i = 0; $i -lt $stamps.Count; $i++) {
        if ($i -ge $closes.Count) { break }
        if ($null -eq $closes[$i]) { continue }
        if ($stamps[$i] -ge $regStart) { continue }
        $last = [double]$closes[$i]
    }
    if ($null -eq $last) { return [pscustomobject]@{ ok = $true; hasPremarket = $false; prevClose = [double]$prev } }
    return [pscustomobject]@{
        ok = $true; hasPremarket = $true; source = 'yahoo'
        prevClose = [math]::Round([double]$prev, 4); premarketPrice = [math]::Round($last, 4)
        premarketVolume = $null; premarketHigh = $null; premarketLow = $null
        gapPercent = [math]::Round((($last - $prev) / $prev) * 100.0, 2)
    }
}

# ---------------------------------------------------------------- run

$nowUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Write-Output ""
Write-Output "PREMARKET GAPPERS - read-only screen, places no orders"
$universe = @(Get-Universe)
Write-Output ("  as of {0}   symbols {1}   filters: |gap| >= {2}%, price >= {3}, preVol >= {4:N0}" -f `
    $nowUtc, $universe.Count, $MinGapPercent, $MinPrice, $MinPremarketVolume)
Write-Output ""

$all = New-Object System.Collections.ArrayList
$failed = 0; $i = 0
foreach ($sym in $universe) {
    $i++
    Write-Progress -Activity 'Scanning premarket' -Status "$sym ($i of $($universe.Count))" `
        -PercentComplete (($i / [math]::Max(1, $universe.Count)) * 100)
    $q = Get-NasdaqPremarket -Symbol $sym
    if (-not $q.ok) { $q = Get-YahooPremarket -Symbol $sym }      # fallback, labelled
    $q | Add-Member -NotePropertyName symbol -NotePropertyValue $sym -Force
    if (-not $q.ok) { $failed++ }
    [void]$all.Add($q)
    if ($ThrottleSeconds -gt 0 -and $i -lt $universe.Count) {
        Start-Sleep -Milliseconds ([int]($ThrottleSeconds * 1000))
    }
}
Write-Progress -Activity 'Scanning premarket' -Completed

# Every symbol failing means this run says NOTHING about the market. That is a
# different outcome from "the market is quiet" and must not exit 0.
if ($failed -ge $universe.Count -and $universe.Count -gt 0) {
    Write-Output "ALL $failed symbol(s) failed - this run says NOTHING about the market."
    $all | Where-Object { -not $_.ok } | Select-Object -First 3 |
        ForEach-Object { Write-Output ("   " + $_.symbol + ": " + $_.error) }
    exit 1
}

$withPre = @($all | Where-Object { $_.ok -and $_.hasPremarket })
$hits = @($withPre | Where-Object {
    $volOk = $true
    if ($MinPremarketVolume -gt 0) {
        # A row whose volume is unknown (Yahoo fallback) cannot satisfy a volume
        # filter and must not be treated as if it had. It is excluded and counted.
        $volOk = ($null -ne $_.premarketVolume -and $_.premarketVolume -ge $MinPremarketVolume)
    }
    ([math]::Abs($_.gapPercent) -ge $MinGapPercent) -and ($_.premarketPrice -ge $MinPrice) -and $volOk
} | Sort-Object { - [math]::Abs($_.gapPercent) })

$unknownVol = @($withPre | Where-Object { $null -eq $_.premarketVolume }).Count

if ($hits.Count -gt 0) {
    Write-Output ("{0,-8} {1,8} {2,10} {3,9} {4,6} {5,12} {6,10} {7,10}  {8}" -f `
        'SYMBOL','GAP %','PREMKT','PREVCLOSE','DIR','PRE VOL','PRE HIGH','PRE LOW','SRC')
    Write-Output ('-' * 96)
    foreach ($h in $hits) {
        $dir = 'UP'; if ($h.gapPercent -lt 0) { $dir = 'DOWN' }
        $vol = 'n/a'; if ($null -ne $h.premarketVolume) { $vol = '{0:N0}' -f $h.premarketVolume }
        $hi  = 'n/a'; if ($null -ne $h.premarketHigh)  { $hi = '{0:N2}' -f $h.premarketHigh }
        $lo  = 'n/a'; if ($null -ne $h.premarketLow)   { $lo = '{0:N2}' -f $h.premarketLow }
        Write-Output ("{0,-8} {1,8:+0.00;-0.00} {2,10:N2} {3,9:N2} {4,6} {5,12} {6,10} {7,10}  {8}" -f `
            $h.symbol, $h.gapPercent, $h.premarketPrice, $h.prevClose, $dir, $vol, $hi, $lo, $h.source)
    }
} else {
    Write-Output "No symbol passed the filter."
}

$noPre = @($all | Where-Object { $_.ok -and -not $_.hasPremarket }).Count
Write-Output ""
Write-Output ("scanned {0} | with premarket trade {1} | passed filter {2} | no premarket {3} | failed {4}" -f `
    $all.Count, $withPre.Count, $hits.Count, $noPre, $failed)
if ($unknownVol -gt 0 -and $MinPremarketVolume -gt 0) {
    Write-Output ("  ({0} name(s) priced from the Yahoo fallback have NO volume and were excluded by the volume filter, not silently passed)" -f $unknownVol)
}
if ($withPre.Count -eq 0) {
    Write-Output "  (no premarket prints anywhere - outside premarket hours, or a weekend)"
}
if ($failed -gt 0) { Write-Output ("  ({0} symbol(s) could not be fetched and are NOT represented above)" -f $failed) }
Write-Output ""
Write-Output "SCREEN ONLY. Not a signal, not a setup, and nothing in SmartEntry reads this."

if ($JsonOut) {
    try {
        $payload = [pscustomobject]@{
            generatedAt = $nowUtc
            filters = [pscustomobject]@{
                minGapPercent = $MinGapPercent; minPrice = $MinPrice
                minPremarketVolume = $MinPremarketVolume
            }
            universeSource = $(if ($Symbols -and $Symbols.Count -gt 0) { 'explicit' } else { 'day_gainers screener' })
            scanned = $all.Count; failed = $failed
            withoutVolume = $unknownVol
            feedsTheGate = $false
            results = $all
        }
        $dir2 = Split-Path -Parent $JsonOut
        if ($dir2 -and -not (Test-Path $dir2)) { New-Item -ItemType Directory -Force -Path $dir2 | Out-Null }
        $payload | ConvertTo-Json -Depth 6 | Out-File -FilePath $JsonOut -Encoding utf8
        Write-Output "wrote $JsonOut"
    } catch {
        # A failed report write must not fail a scan that already succeeded.
        Write-Output ("could not write {0}: {1}" -f $JsonOut, $_.Exception.Message)
    }
}
exit 0
