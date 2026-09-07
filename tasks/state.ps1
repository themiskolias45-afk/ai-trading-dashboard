$s = (Invoke-WebRequest -Uri 'http://localhost:3001/api/signals' -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
Write-Output ("updatedAt " + $s.updatedAt)
foreach ($k in @('btc','gold','spx')) {
  $x = $s.$k
  Write-Output ("{0,-5} {1,-4} conf={2,-3} setup={3,-18} src={4,-8} dailyTrend={5,-16} h4={6,-4} h1={7}" -f `
    $k, $x.signal, $x.confidence, $x.setup, $x.sourceSymbol, $x.trend, $x.h4.signal, $x.h1.signal)
}
Write-Output ''
$c = (Invoke-WebRequest -Uri 'http://localhost:3001/api/mt5/control' -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
Write-Output ("halted = " + $c.halted + "  (" + $c.setBy + ")")
$src = (Invoke-WebRequest -Uri 'http://localhost:3001/api/mt5/candles' -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
foreach ($k in @('btc','gold','spx')) {
  $f = $src.sources.$k
  Write-Output ("feed {0,-5} {1,-8} ageMs={2} inUse={3}" -f $k, $f.brokerSymbol, $f.ageMs, $f.inUse)
}
