# Laptop sleep — prepared changes, for review before anything is applied

**Nothing in this file has been applied.** Power and registry configuration are system
settings; they are yours to make. Everything here was measured on THEMIS on 2026-08-21.

---

## What was measured, so the reasoning can be checked rather than believed

The caller is named in the event log, not inferred:

```
Kernel-Power 187  ApiCallerName = \Device\HarddiskVolume3\Windows\System32\winlogon.exe
User32     1074   winlogon.exe initiated the power off on behalf of NT AUTHORITY\SYSTEM
                  Reason Code: 0x500ff
Kernel-Power  42  Reason = 4  (Application API)
```

`0x500ff` = `SHTDN_REASON_MAJOR_SYSTEM (0x50000)` | `MINOR_OTHER (0xff)` — Windows' own
sleep path via winlogon. Not a third-party utility, not the lid, not battery. Identical
across all five sleeps sampled.

### The settings people reach for first are ALREADY correct

| setting | AC | DC |
|---|---|---|
| Sleep after | `0` = **Never** | `0` = **Never** |
| Hibernate after | never | never |
| Allow wake timers | `1` = **Enabled** | `1` = **Enabled** |
| Turn off display after | 60 min | never |

`powercfg /a` reports **Standby (S0 Low Power Idle) Network Connected** — Modern Standby
hardware. On Modern Standby, S0 entry follows the display-off / user-absent path and is
**not governed by "Sleep after"**, which is exactly why that setting reads *Never* while
the machine keeps sleeping. **Do not spend time on sleep timeouts. They are not the
cause.**

### The fault is the WAKE, not the sleep

`SmartEntry Ensure Running` is the only SmartEntry task with `WakeToRun = True`, and wake
timers are policy-enabled on both AC and DC. Across the 33.4h outage it should have fired
~200 times. It fired **zero** times:

```
08-19 19:03:17  id=42   entering sleep
08-19 19:03:19  id=107  resumed from sleep        <- 2 seconds later
      ...        33 HOURS, ZERO System log entries ...
08-21 04:04:58  id=506  entering Modern Standby
08-21 04:04:58  id=507  exiting Modern Standby
```

159 System events in the hour before, **0 across the whole gap**, 71 on return. A running
machine logs. And `powercfg /lastwake` reports **Wake Source Count 0** — a person woke it,
no timer did.

**So the 10-minute self-heal cannot work on this box: nothing wakes it.**

---

## STEP 0 — run this first. It decides which change below is the right one.

Elevated PowerShell. Read-only, changes nothing:

```powershell
powercfg /waketimers
powercfg /requests
powercfg /sleepstudy      # writes sleepstudy-report.html to the current directory
```

`powercfg /waketimers` is the one that matters. It answers a question I could not:

- **If the Ensure Running timer is listed** → the timer is armed and Modern Standby is
  ignoring it. Option C is the only thing that will help.
- **If it is NOT listed** → the timer is not being armed at all. Option B is the fix and
  Option C is unnecessary risk.

Paste the output back and I will tell you which to take.

---

## OPTION A — keep the box awake while SmartEntry runs (lowest risk, start here)

**Rationale.** If the machine never idles into S0, the wake problem never arises. This is
the documented mechanism for exactly this case — the same one media players and backup
software use — and it needs no reboot and no registry edit.

**Apply** (elevated):

```powershell
powercfg /requestsoverride PROCESS node.exe SYSTEM
```

**Verify:**

```powershell
powercfg /requestsoverride      # should now list node.exe under [PROCESS]
powercfg /requests              # SYSTEM: should show node.exe once the server is running
```

**Roll back** (elevated) — passing no request types clears it:

```powershell
powercfg /requestsoverride PROCESS node.exe
```

### Read this before applying it

`node.exe` is **not specific to the trading server**. There are 66 `node.exe` processes on
this box right now — MCP servers, npx launches, tooling. This override therefore keeps the
machine awake whenever *any* node process runs, which in practice is close to "always
awake while you are working."

That is very likely what you want for a machine that is supposed to be running a trading
stack continuously. But it is a real behaviour change to state plainly: **expect the
laptop to stop sleeping on its own, and expect the battery to drain accordingly when off
AC.** If you want it narrower, the honest answer is that it needs a dedicated executable
to hold the request rather than a name as generic as `node.exe` — say so and I will build
one.

---

## OPTION B — let the market-critical jobs wake the box

**Rationale.** Only `SmartEntry Ensure Running` can currently request a wake. The jobs that
must hit a specific clock time — the pre-open plan, the post-close analysis — cannot. If
Step 0 shows timers are simply not being armed, this is the fix.

**Apply** (elevated). This mutates only `WakeToRun` and preserves every other setting on
each task:

```powershell
$tasks = @(
  'SmartEntry Pre-Open Plan',
  'SmartEntry Post-Close Analysis',
  'SmartEntry - Daily Check',
  'SmartEntry Data Backup',
  'SmartEntryVPSBackupPull'
)
foreach ($n in $tasks) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction Stop
  $t.Settings.WakeToRun = $true
  Set-ScheduledTask -TaskName $n -Settings $t.Settings | Out-Null
  "set WakeToRun on $n"
}
```

**Verify:**

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -like '*SmartEntry*' } |
  Select-Object TaskName, @{n='Wake';e={$_.Settings.WakeToRun}} | Format-Table -AutoSize
```

**Roll back** — same block with `$false`.

### Read this before applying it

This is **only useful if wake timers actually fire on this hardware**, which is precisely
what Step 0 establishes. Applying it before Step 0 risks concluding "the fix didn't work"
when the real answer is that the timer was never armed. The list above is deliberately the
market-critical jobs only — waking a laptop every ten minutes all night for a health check
is not obviously worth it, and `Ensure Running` already has the flag.

---

## OPTION C — disable Modern Standby (highest risk, needs a reboot, MAY NOT WORK)

**Only if Step 0 shows the timer is armed and being ignored.**

**Apply** (elevated), then reboot:

```cmd
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Power" /v PlatformAoAcOverride /t REG_DWORD /d 0 /f
```

**Verify after the reboot — this is the step that decides whether to keep it:**

```powershell
powercfg /a
```

**Roll back** (elevated), then reboot:

```cmd
reg delete "HKLM\SYSTEM\CurrentControlSet\Control\Power" /v PlatformAoAcOverride /f
```

### Read this before applying it — I cannot promise this works

`powercfg /a` currently prints **two different reasons** for S3 being unavailable:

```
Standby (S3)
    The system firmware does not support this standby state.
    This standby state is disabled when S0 low power idle is supported.
```

The second line is a consequence of Modern Standby being on, and on many machines removing
S0 reveals a working S3. **The first line says the firmware has no S3 at all.** Both are
printed, so which one governs is not knowable from here.

If the firmware genuinely lacks S3, then after this change and a reboot the machine has
**Hibernate and Fast Startup only** — and a hibernating box is *more* off than a sleeping
one, not less. That is a worse outcome than today.

Hence the verification step is not optional: after rebooting, `powercfg /a` must list
**Standby (S3)** under *available*. If it does not, roll the value back and reboot again.
Do not leave it applied on the assumption it helped.

---

## How to confirm any of this actually fixed it

Do not read the last heartbeat tick — that is what hid this for weeks. The tick *after* a
hole restarts everything before reporting, so the log looks healthy either side of an
outage. Read the **gaps**:

```
node tasks/doctor.cjs
```

The `checkCoverageGaps` finding is the one to watch. Today it reports *"2 holes in the last
48h totalling 45.2h; worst was 33.4h."* A working fix drives that to zero holes over a
subsequent 48h window — give it two days before believing it.

---

## What is NOT worth doing

- **Changing "Sleep after."** Already `Never` on both AC and DC. It is not the cause.
- **Changing the lid action.** The sleeps are `winlogon` on behalf of `SYSTEM`, reason
  `MAJOR_SYSTEM`. No lid event precedes any of them.
- **Disabling hibernate.** Nothing here indicates hibernate is involved, and it is the only
  remaining sleep state if Option C goes wrong.

---

## Scope: what a laptop outage actually costs

The VPS runs continuously and trades independently — during the 33h hole it stayed up and
is currently at `dailyPnl 19.43`, not halted. **Trading did not stop.**

But the laptop runs its own bridge and currently holds both open positions. During an
outage those are unmanaged by SmartEntry and protected only by broker-side SL and TP —
which both positions do carry. Not unprotected; not supervised either. That is the risk
being priced, and it is the reason this is worth fixing rather than accepting.
