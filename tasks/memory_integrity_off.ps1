<#
    Turn Memory Integrity (HVCI) OFF, or back ON with -Undo. RUN ELEVATED.

    WHY. 13 unexpected shutdowns are on record in tasks\crash_ledger.jsonl. Eight are
    bugcheck 0x00020001 HYPERVISOR_ERROR carrying an IDENTICAL parameter fingerprint
    (0x28, 0x2, 0x6500000000000000) - one repeating fault, not eight coincidences.

    Measured on this box 2026-09-09, not assumed:
      - WSL             not installed
      - Docker          absent
      - VMware/VBox     absent
      - Credential Guard  SecurityServicesConfigured = 2 (HVCI only, CG not configured)
      - VirtualizationBasedSecurityStatus = 2 (running)
      - HypervisorEnforcedCodeIntegrity\Enabled = 1

    The Windows hypervisor is loaded on this machine for EXACTLY ONE consumer - Memory
    Integrity - and that hypervisor is the component throwing the bugcheck.

    WHAT THIS IS NOT. It is a diagnostic, not a proven fix. It cannot address the OTHER
    signature in the ledger (BugcheckCode = 0, five of the thirteen, kernel never ran).
    Judge it on whether 0x00020001 stops recurring.

    WHAT IT DOES NOT TOUCH. Defender antivirus, firewall, SmartScreen, TPM, BitLocker,
    Secure Boot, the power plan, Fast Startup, Storage Sense, any driver, and every part
    of the trading stack - the engine, the confidence gate, learning.json, the journal,
    the bridges, MT5, and all 63 scheduled tasks. It writes ONE registry value.

    SAFETY. The current DeviceGuard registry state is exported to tasks\backups\ BEFORE
    anything is written, and the script refuses to continue if that backup is not on disk.
    Nothing is ever deleted.

    TO UNDO:  powershell -File tasks\memory_integrity_off.ps1 -Undo     (then reboot)
    Or the same switch in the GUI: Settings > Privacy and security > Windows Security >
    Device security > Core isolation > Memory integrity.
#>

[CmdletBinding()]
param(
    [switch]$Undo
)

$ErrorActionPreference = 'Stop'

$HvciKey   = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity'
$Repo      = 'C:\Users\User\ai-trading-dashboard'
$BackupDir = Join-Path $Repo 'tasks\backups'

$TargetValue = if ($Undo) { 1 } else { 0 }
$Intent      = if ($Undo) { 'RESTORE Memory Integrity (HVCI) to ON' } else { 'Turn Memory Integrity (HVCI) OFF' }

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

# --- guard: elevation -------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'NOT ELEVATED. Close this, open PowerShell as Administrator, run it again.' -ForegroundColor Red
    Write-Host 'Nothing was changed.' -ForegroundColor Red
    exit 1
}

Write-Step $Intent

# --- read the state we are about to change ----------------------------------------
$before = (Get-ItemProperty $HvciKey -Name Enabled -ErrorAction SilentlyContinue).Enabled
$dg     = Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard -ErrorAction SilentlyContinue

Write-Host ("HVCI Enabled (registry)          : {0}" -f $(if ($null -eq $before) { '<absent>' } else { $before }))
Write-Host ("VBS status (0=off 1=idle 2=run)  : {0}" -f $dg.VirtualizationBasedSecurityStatus)
Write-Host ("SecurityServicesConfigured       : {0}" -f ($dg.SecurityServicesConfigured -join ','))
Write-Host ("SecurityServicesRunning          : {0}" -f ($dg.SecurityServicesRunning -join ','))

# A configured service other than 2 (HVCI) means something ELSE depends on the
# hypervisor and the premise of this script no longer holds. Stop rather than guess.
$otherConsumers = @($dg.SecurityServicesConfigured | Where-Object { $_ -ne 2 })
if ($otherConsumers.Count -gt 0) {
    Write-Host ''
    Write-Host "STOPPING. A VBS service other than HVCI is configured: $($otherConsumers -join ',')" -ForegroundColor Red
    Write-Host 'This script assumes HVCI is the only consumer. That is no longer true.' -ForegroundColor Red
    Write-Host 'Nothing was changed.' -ForegroundColor Red
    exit 1
}

if ($before -eq $TargetValue) {
    Write-Host ''
    Write-Host "Already at Enabled=$TargetValue. Nothing to do, nothing changed." -ForegroundColor Yellow
    exit 0
}

# --- back up BEFORE writing, and verify the backup landed -------------------------
Write-Step 'Backup'
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

$stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $BackupDir "deviceguard-$stamp.reg"

# reg.exe export writes the whole DeviceGuard subtree, restorable with reg.exe import.
& reg.exe export 'HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard' $backupFile /y | Out-Null

if (-not (Test-Path $backupFile) -or (Get-Item $backupFile).Length -eq 0) {
    Write-Host "BACKUP FAILED - $backupFile is missing or empty. Nothing was changed." -ForegroundColor Red
    exit 1
}
Write-Host "Backed up to $backupFile ($((Get-Item $backupFile).Length) bytes)" -ForegroundColor Green

# --- the single write -------------------------------------------------------------
Write-Step 'Write'
if (-not (Test-Path $HvciKey)) { New-Item -Path $HvciKey -Force | Out-Null }
Set-ItemProperty -Path $HvciKey -Name Enabled -Value $TargetValue -Type DWord

$after = (Get-ItemProperty $HvciKey -Name Enabled).Enabled
Write-Host "HVCI Enabled $before -> $after" -ForegroundColor Green

# --- what happens next ------------------------------------------------------------
Write-Step 'REBOOT REQUIRED'
Write-Host 'The registry is set. The hypervisor does not unload until the machine restarts.'
Write-Host ''
Write-Host 'AFTER the reboot, verify it actually took (a UEFI lock can silently override):' -ForegroundColor Cyan
Write-Host '  (Get-CimInstance Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard).VirtualizationBasedSecurityStatus'
Write-Host '  0 or 1 = the hypervisor is no longer running. 2 = it is STILL running, tell JARVIS.'
Write-Host ''
Write-Host 'To undo:' -ForegroundColor Cyan
Write-Host '  powershell -File tasks\memory_integrity_off.ps1 -Undo     (then reboot)'
Write-Host "  or restore the whole subtree:  reg.exe import `"$backupFile`""
