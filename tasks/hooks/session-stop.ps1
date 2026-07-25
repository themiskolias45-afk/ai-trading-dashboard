# Saves a brief session summary to the vault when JARVIS closes
$ts     = Get-Date -Format 'yyyy-MM-dd HH:mm'
$today  = Get-Date -Format 'yyyy-MM-dd'
$vault  = 'C:\Users\User\Documents\Brain\01 - Daily Notes'
$note   = "$vault\$today.md"

# Last 5 commits as session record
$commits = git -C 'C:\Users\User\ai-trading-dashboard' log --oneline -5 2>$null

$content = @"

## JARVIS Session — $ts
$($commits -join "`n")
"@

if (Test-Path $vault) {
    Add-Content -Path $note -Value $content -Encoding UTF8 -ErrorAction SilentlyContinue
}
