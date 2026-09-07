# Laptop sleep — prepared changes, for review before anything is applied

**Nothing in this file has been applied.** Power and registry configuration are system
settings; they are yours to make. Everything here was measured on THEMIS on 2026-08-21.

**Step 0 is now ANSWERED** — see below. It did not need elevation after all, and the
answer removes one of the three options.

---

## The finding, in one line

The machine **hibernates** every time it sleeps, and **nothing has ever woken it on a
timer** — 0 of 40 wakes in the last month. It comes back only when a person touches it.

```
sleep episodes analysed : 40        window: 07-23 -> 08-21  (692.1 h)
total asleep            : 492.4 h   = 71.1% of the last month
wakes with a TIMER source : 0 of 40      (every one: WakeSourceType 0 = Unknown)
episodes that HIBERNATED  : 40 of 40     (300k-600k pages to hiberfil each time)
```

The doctor's "45.2h in 48h" was not an incident. It is the normal behaviour of this box.

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
**not governed by "Sleep after"**, which is why that setting reads *Never* while the
machine keeps sleeping. **Do not spend time on sleep timeouts. They are not the cause.**

---

## STEP 0 — ANSWERED, and it did not need elevation

`powercfg /waketimers` needs admin and this session is not elevated. But the
**Power-Troubleshooter** log answers the same question and is readable as a normal user:

```powershell
Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1} -MaxEvents 40
```

Every one of the last 40 resumes carries:

```
WakeSourceType   = 0        ->  rendered as "Wake Source: Unknown"
WakeTimerOwner   = ''       ->  no task, no timer, ever
HiberPagesWritten = 311704  ->  it HIBERNATED (S4), not merely S0
```

**Both halves matter.** The machine does not just enter connected standby — it goes all
the way to hibernate, every single time. A hibernated machine has no running OS, so a
scheduled-task timer *cannot* fire. Only wake-capable hardware can resume it, and on
Modern Standby that is generally disabled.

> Caveat on method: a first pass of this count reported "40 of 40 timer wakes", the exact
> opposite. That was a bug in the counting script — in PowerShell `$null -ne ''` is **True**,
> so episodes missing the field were scored as timer wakes. Cast to `[string]` before
> comparing. The corrected count is 0 of 40, and it agrees with the rendered message
> ("Wake Source: Unknown") on every event.

---

## OPTION A — keep the box awake (RECOMMENDED, and now the only one that addresses the cause)

**Rationale.** Nothing can wake this machine once it hibernates. So the only thing that
works is to stop it going down. No reboot, no registry, one command to undo.

**Apply** (elevated):

```powershell
powercfg /requestsoverride PROCESS node.exe SYSTEM
```

**Verify:**

```powershell
powercfg /requestsoverride      # should now list node.exe under [PROCESS]
powercfg /requests              # SYSTEM: should show node.exe while the server runs
```

**Roll back** (elevated) — passing no request types clears it:

```powershell
powercfg /requestsoverride PROCESS node.exe
```

### Read this before applying it

`node.exe` is **not specific to the trading server**. There were 66 `node.exe` processes on
this box when measured — MCP servers, npx launches, tooling. This override therefore keeps
the machine awake whenever *any* node process runs, which in practice is close to "always
awake while you are working."

For a machine meant to run a trading stack continuously that is probably what you want,
but state it plainly: **expect the laptop to stop sleeping on its own, and expect battery
drain off AC.** If you want it narrower it needs a dedicated executable to hold the
request rather than a name as generic as `node.exe` — say so and I will build one.

---

## OPTION B — WakeToRun on the other tasks (DO NOT BOTHER — measured futile)

Originally listed as a candidate. **The evidence rules it out.**

`SmartEntry Ensure Running` **already has `WakeToRun = True`** and has woken this machine
**zero times in 40 attempts across a month**. Setting the same flag on five more tasks
adds five more flags that will also never fire, because the box is hibernated when they
are due.

Left in this document deliberately rather than deleted, so the next person who has the
same idea can see it was tested and why it fails. Revisit only if Option C is applied and
`powercfg /a` then shows S3 available.

---

## OPTION C — disable Modern Standby (only if you want timers to work; carries real risk)

Option A solves the outage without this. Option C is only worth it if you specifically
want scheduled tasks to be able to wake the machine.

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
**Hibernate and Fast Startup only** — and it is already hibernating today, so that outcome
is no better and possibly worse. Hence the verification step is not optional: after
rebooting, `powercfg /a` must list **Standby (S3)** under *available*. If it does not, roll
back and reboot again.

---

## How to confirm any of this actually fixed it

Do not read the last heartbeat tick — that is what hid this for weeks. The tick *after* a
hole restarts everything before reporting, so the log looks healthy either side of an
outage. Read the **gaps**:

```
node tasks/doctor.cjs
```

Watch the `checkCoverageGaps` finding. A working fix drives it to zero holes over a
subsequent 48h window — give it two days before believing it.

---

## What is NOT worth doing

- **Changing "Sleep after."** Already `Never` on both AC and DC. Not the cause.
- **Changing the lid action.** The sleeps are `winlogon` on behalf of `SYSTEM`, reason
  `MAJOR_SYSTEM`. No lid event precedes any of them.
- **Setting WakeToRun on more tasks.** Measured futile — see Option B.

---

## Scope: what a laptop outage actually costs

The VPS runs continuously and trades independently — during the 33h hole it stayed up and
is currently at `dailyPnl 19.43`, not halted. **Trading did not stop.**

But the laptop runs its own bridge and currently holds both open positions. During an
outage those are unmanaged by SmartEntry and protected only by broker-side SL and TP —
which both positions do carry. Not unprotected; not supervised either. At 71% asleep, that
is the normal state of this box rather than an exception, which is the real argument for
fixing it.
