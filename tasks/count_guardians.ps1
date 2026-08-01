# Prints how many SmartEntry Guardian processes are running (including the caller's
# own cmd.exe, which is expected — the guardian treats a count above 1 as a duplicate).
#
# This lives in its own file rather than inline in watchdog_guardian.bat because the
# quoting needed to embed a PowerShell pipeline inside a batch `for /f` backtick block
# is fragile: an escaping mistake makes the query return nothing, the guardian reads
# that as "no duplicates", and the single-instance guard silently fails open. A file
# with no escaping at all cannot fail that way.
#
# WQL does the filtering so there is no pipeline to escape and no dependency on the
# caller's locale.
$query = "SELECT ProcessId FROM Win32_Process WHERE Name = 'cmd.exe' AND CommandLine LIKE '%watchdog_guardian%'"
try {
    @(Get-CimInstance -Query $query -ErrorAction Stop).Count
} catch {
    # Fail SAFE, not open: if the process list cannot be read we claim a duplicate
    # exists so the new guardian backs off. Two guardians would mean two watchdogs,
    # and two watchdogs restarting bridges independently is how duplicate bridges
    # land on a live account.
    Write-Output 99
}
