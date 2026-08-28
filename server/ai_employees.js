'use strict';
/**
 * THE AI EMPLOYEE ROSTER — one map, so the whole workforce is visible in one place.
 *
 * WHY THIS EXISTS. The capability catalogue (ai_registry.js) answers "what CAN be run":
 * 53 skills, 6 agents, 29 tools. It cannot answer "who is employed, to do what, on which
 * box, reading what, writing where, and on whose clock". That answer was spread across
 * auto_daily.bat, auto_weekly_vps.bat, morning_agent.bat, five Task Scheduler entries on
 * two machines, and nobody's head. On 2026-08-28 a weekly agent's correct finding sat
 * unread for five days, the VPS agents were booting from an older CLAUDE.md, and their
 * /signal skill still quoted a gate that moved four weeks earlier — three failures that
 * are all the same failure: no single place said what the workforce was supposed to be.
 *
 * EVERY EMPLOYEE DECLARES SEVEN THINGS, and a missing one is itself the finding:
 *   brain     which model reasons for it
 *   context   what it reads BEFORE it works — an agent with no brief re-proposes settled work
 *   tools     the MCP tools it may call
 *   skills    the .claude/commands it runs
 *   loop      its work, start to finish, as ordered steps
 *   memory    where its output persists, and who reads that
 *   playbook  what it must never do
 *   clock     its schedule and WHICH BOX it runs on
 *
 * THIS FILE IS A DESCRIPTION, NOT A SCHEDULER. Nothing here spawns an agent, runs a
 * skill, calls a tool or places a trade — it reads as data and is served read-only. The
 * clock field NAMES the Task Scheduler entry that really fires; it does not create one.
 * That separation is deliberate: a roster that could hire would be a roster that could
 * hire by accident.
 *
 * A `status` of PROPOSED means the work is specified and NOT employed. It appears on the
 * map so the gap is visible, and it costs nothing until a human creates the schedule.
 * Never quote a PROPOSED employee as something the system does.
 */

const EMPLOYED = 'EMPLOYED';
const PROPOSED = 'PROPOSED';

const ROSTER = [
  {
    id: 'daily-check',
    title: 'Daily Check',
    status: EMPLOYED,
    mission: 'Every morning, say whether to trade today and why not, from live state only.',
    brain: 'claude-opus-5 via the CLI subscription (ANTHROPIC_API_KEY is cleared so it '
      + 'never bills pay-as-you-go credit)',
    context: ['tasks/ai_brief.md — prior decisions, open proposals, what is already measured'],
    tools: ['get_strategy_settings', 'get_signals', 'get_risk_status', 'get_journal'],
    skills: ['/daily'],
    loop: [
      'the deterministic scorers run FIRST, so the report reflects today\'s evidence: rejection ledger, near-miss, stop-variant, shadow shorts, config drift, candle read',
      'doctor self-test writes a per-run verdict whether or not the agent then succeeds',
      'read the brief, then journal, settings, signals, risk',
      'mark any signal at or above the LIVE gate as SIGNAL READY',
      'one-line verdict: TRADE TODAY or WAIT',
    ],
    memory: 'tasks/logs/daily_YYYYMMDD.txt, harvested into the proposal ledger by ai_work_ledger.js',
    playbook: [
      'never assume the gate — read confidenceThreshold, and say so first if settingsError is non-null',
      'never re-raise anything the brief marks decided',
      'propose only: no source edits, no commits',
    ],
    clock: { schedule: '07:30 daily', boxes: ['laptop', 'vps'], task: 'SmartEntry - Daily Check / SmartEntryDailyCheck', script: 'tasks/auto_daily.bat / tasks/auto_daily_vps.bat' },
  },
  {
    id: 'morning-agent',
    title: 'Morning Agent',
    status: EMPLOYED,
    mission: 'Find one low-risk improvement a day and write it up so it can be judged.',
    brain: 'claude-opus-5',
    context: ['tasks/ai_brief.md', 'tasks/logs/morning_proposals.txt — what it already proposed'],
    tools: ['get_brain_status', 'get_signals', 'get_learning', 'get_evidence_board'],
    skills: ['/improve', '/fix'],
    loop: [
      'read the brief and its own past proposals',
      'compare today\'s live state against the frozen snapshot it left yesterday',
      'find ONE improvement, verify the citation resolves before writing it',
      'append under the literal PROPOSED FIX: marker so ai_work_ledger.js can harvest it',
    ],
    memory: 'tasks/logs/morning_proposals.txt + tasks/logs/agent_log.txt',
    playbook: [
      'cite a file:line or a measurement — a proposal with a broken citation cannot be followed',
      'stop re-flagging once an item is implemented or explicitly rejected',
      'propose only',
    ],
    clock: { schedule: '07:00 daily', boxes: ['laptop', 'vps'], task: 'JARVIS Morning Agent / SmartEntryMorningAgent', script: 'tasks/morning_agent.bat / tasks/morning_agent_vps.bat' },
  },
  {
    id: 'weekly-review',
    title: 'Weekly Algo Review',
    status: EMPLOYED,
    mission: 'Grade its own past calls, then find one weakness the trades actually support.',
    brain: 'claude-opus-5',
    context: ['tasks/ai_brief.md section 3 — its own ungraded calls'],
    tools: ['get_journal', 'get_performance', 'get_learning'],
    skills: ['/weekly', '/review'],
    loop: [
      'STEP ZERO: grade every ungraded past call right / wrong / unproven, with the evidence that settles it',
      'week summary — trades, P&L, win rate, or say plainly there were none',
      'best and worst asset',
      'one weakness supported by real trades, not speculation',
      'one PROPOSED FIX naming the function and the change',
    ],
    memory: 'tasks/logs/weekly_YYYYMMDD.txt',
    playbook: [
      'grade yourself honestly — a wrong call recorded as wrong is worth more than a flattering record',
      'if there are too few closed trades to support a conclusion, say exactly that and stop',
      'never run ai_decide — a human records decisions',
    ],
    clock: { schedule: 'Sunday 10:00', boxes: ['laptop', 'vps'], task: 'SmartEntry - Weekly Algo Review / SmartEntryWeeklyReview', script: 'tasks/auto_weekly.bat / tasks/auto_weekly_vps.bat' },
  },
  {
    id: 'agent-drain',
    title: 'Agent Queue Drain',
    status: EMPLOYED,
    mission: 'Run the briefs that were parked when the subscription window was closed.',
    brain: 'claude-opus-5',
    context: ['tasks/agent_queue.jsonl — the parked briefs'],
    tools: [],
    skills: [],
    loop: [
      'read the queue',
      'run each parked brief in turn',
      'write a completion marker so the ledger can tell a finished run from a killed one',
    ],
    memory: 'tasks/logs/agent_drain.txt',
    playbook: ['a parked job is not a failed job — never report one as a failure'],
    clock: { schedule: 'hourly', boxes: ['laptop', 'vps'], task: 'SmartEntryAgentDrain', script: 'tasks/drain_agents.bat' },
  },
  {
    id: 'coverage-audit',
    title: 'Coverage Audit',
    status: EMPLOYED,
    mission: 'Check that every other employee actually ran, and say which did not.',
    brain: 'none — deterministic PowerShell, no model, no tokens',
    context: ['Task Scheduler state', 'tasks/logs/*'],
    tools: [],
    skills: [],
    loop: [
      'read every scheduled task\'s state, last result and next run',
      'check server, bridge, ledgers, peers and alerting',
      'exit 1 on a RED finding — the exit code IS the alarm',
    ],
    memory: 'tasks/logs/coverage_audit.txt + coverage_audit_state.json',
    playbook: [
      'a false RED is as costly as a missed one — it trains the reader to skim',
      'never report a task as broken for having no next run when it is event-triggered',
    ],
    clock: { schedule: 'every 12h', boxes: ['laptop', 'vps'], task: 'SmartEntryCoverageAudit', script: 'tasks/coverage_audit.ps1' },
  },

  {
    id: 'gate-auditor',
    title: 'Gate Auditor',
    status: EMPLOYED,
    mission: 'Find every place that states a live setting as a number and is now wrong.',
    brain: 'none — deterministic, no model, no tokens',
    context: ['server/strategy_settings.json — the live values, never a guessed default'],
    tools: [],
    skills: [],
    loop: [
      'read the LIVE settings; no settings means no verdict, never a fallback',
      'scan 68 files — 9 named plus every skill and agent, expanded by directory so a skill added tomorrow is covered',
      'flag only CLAIMS about a setting, never every integer; a phrase marked historical is exempt',
    ],
    memory: 'tasks/logs/daily_YYYYMMDD.txt (runs inside the daily check, --emit)',
    playbook: [
      'read-only; --strict deliberately NOT passed so a drifted comment cannot fail the nightly run',
      'never flag a line that READS the setting live — that is the correct pattern',
    ],
    clock: { schedule: 'nightly, inside the daily check', boxes: ['laptop', 'vps'], task: 'SmartEntry - Daily Check', script: 'tasks/config_drift.cjs' },
  },
  {
    id: 'plan-drafter',
    title: 'Pre-Open Plan Drafter',
    status: EMPLOYED,
    mission: 'Write the day\'s plan from live state before the New York open.',
    brain: 'none — deterministic',
    context: ['/api/signals', '/api/strategy-settings', 'the economic calendar'],
    tools: ['get_signals', 'get_strategy_settings'],
    skills: ['/plan'],
    loop: [
      'walk BACKWARD from 60 minutes before the open in 15-minute steps until outside every news blackout',
      'build the plan from live signals and levels, never from a cached copy',
      'state what the system KNOWS versus what it assumes',
    ],
    memory: 'tasks/analysis/ + the Plan page',
    playbook: ['a plan that fires inside the blackout it exists to prepare for is worse than none'],
    clock: { schedule: 'daily, blackout-aware slot', boxes: ['laptop', 'vps'], task: 'SmartEntry Pre-Open Plan', script: 'tasks/deep_plan.cjs' },
  },
  {
    id: 'band-monitor',
    title: 'Band Monitor',
    status: EMPLOYED,
    mission: 'Watch what the RSI ceiling move actually bought, on both boxes.',
    brain: 'none — deterministic',
    context: ['/api/near-miss', '/api/signals'],
    tools: ['get_signals'],
    skills: [],
    loop: ['sample both boxes every 15 minutes', 'record what sits inside the new band', 'never act — only record'],
    memory: 'tasks/logs/band_monitor.txt',
    playbook: ['read-only; it measures a decision already taken and must not re-take it'],
    clock: { schedule: 'every 15 min', boxes: ['laptop', 'vps'], task: 'SmartEntry Band Monitor', script: 'tasks/band_monitor.cjs' },
  },
  {
    id: 'peer-watch',
    title: 'Peer Watch',
    status: EMPLOYED,
    mission: 'Notice when the other box stops answering, and say so once.',
    brain: 'none — deterministic',
    context: ['the peer\'s /api/status and heartbeat'],
    tools: ['get_fleet_status'],
    skills: [],
    loop: ['poll the peer', 'require TWO consecutive failures before alerting', 'alert once, then say RECOVERED once'],
    memory: 'tasks/logs/vps_monitor.txt',
    playbook: ['an alarm that repeats every cycle is one you stop reading'],
    clock: { schedule: 'every 5 min', boxes: ['laptop'], task: 'SmartEntryVpsMonitor', script: 'tasks/vps_monitor.ps1' },
  },
  {
    id: 'bar-keeper',
    title: 'Bar Keeper',
    status: EMPLOYED,
    mission: 'Keep the research bars current without ever risking the live bridge.',
    brain: 'none — deterministic',
    context: ['/api/mt5/candles/raw — the bars the bridge already pushed'],
    tools: [],
    skills: [],
    loop: [
      'REFUSE outright while any position is open — the exporter opens a second MT5 client and a conflict can drop the bridge',
      'otherwise append only rows strictly newer than the last on disk',
      'never bridge a gap: a discontinuous series is worse than a stale one',
    ],
    memory: 'tasks/history/*.csv',
    playbook: [
      'exit 3 means REFUSED and is the expected result most days, not a failure',
      'never overwrite — append only, or years of history vanish silently',
    ],
    clock: { schedule: 'hourly', boxes: ['laptop', 'vps'], task: 'SmartEntry Refresh Bars', script: 'tasks/refresh_bars.cjs + tasks/persist_bars.cjs' },
  },

  // ── PROPOSED — specified, not employed. Visible so the gap is legible. ──────────
  {
    id: 'evidence-scorer',
    title: 'Evidence Scorer',
    status: PROPOSED,
    mission: 'Turn the accumulating ledgers into verdicts, so evidence stops piling up unread.',
    brain: 'none — deterministic, the same class as the coverage audit',
    context: ['tasks/shadow_shorts.jsonl', 'tasks/near_misses.jsonl', 'tasks/stop_variants.jsonl'],
    tools: ['get_rejection_evidence'],
    skills: [],
    loop: [
      'score every unresolved row forward on real broker bars',
      'emit a per-cohort verdict with its sample size and floor',
      'refuse a verdict below the floor rather than publishing an anecdote',
    ],
    memory: 'the _scored.jsonl beside each ledger',
    playbook: [
      'feedsTheGate stays false — this measures, it never admits or suppresses',
      'where it contradicts a walk-forward, the walk-forward wins',
    ],
    clock: { schedule: 'nightly, after the ledgers are written', boxes: ['vps'], task: null, script: null },
    whyNotYet: 'The near-miss and stop-variant scorers exist; a shadow-short scorer does not. '
      + 'Employ this only once there are enough resolved rows for a verdict to mean anything.',
  },
  {
    id: 'fleet-warden',
    title: 'Fleet Warden',
    status: PROPOSED,
    mission: 'Watch the two boxes for drift in code, config and capability — not just the engine.',
    brain: 'none — deterministic',
    context: ['tasks/vps_parity.cjs output'],
    tools: ['get_fleet_status'],
    skills: [],
    loop: [
      'run parity including the whole-surface presence and content sweep',
      'name every file that is absent on one box or differs in content',
      'separate the deliberate absences from the drift, and never auto-sync',
    ],
    memory: 'tasks/logs/vps_parity_last.json',
    playbook: [
      'never sync blindly — bridge_tags.ps1 must stay laptop-only or a second bridge starts on a one-account box',
      'report; a human decides direction',
    ],
    clock: { schedule: 'daily', boxes: ['laptop'], task: null, script: 'tasks/vps_parity.cjs' },
    whyNotYet: 'The tool exists and now sees the whole surface, but nothing runs it on a schedule — '
      + 'it only ever ran when someone looked, which is how 23 capability files went missing unnoticed.',
  },
  {
    id: 'calibration-officer',
    title: 'Calibration Officer',
    status: PROPOSED,
    mission: 'Ask whether confidence means anything — does 86% actually win 86% of the time?',
    brain: 'none — deterministic',
    context: ['server/journal.json', 'the replayed cohort table'],
    tools: ['get_performance', 'get_learning'],
    skills: [],
    loop: [
      'bucket closed trades by the confidence they fired at',
      'compare realised win rate to the confidence claimed, per asset',
      'refuse a verdict below the sample floor rather than publishing an anecdote',
    ],
    memory: 'a scored calibration record beside the journal',
    playbook: [
      'per ASSET, never pooled — pooling lets Gold vote on an SPX question',
      'feedsTheGate false: this measures confidence, it must never adjust it',
    ],
    clock: { schedule: 'weekly', boxes: ['vps'], task: null, script: null },
    whyNotYet: 'The need is proven and unmonitored: SP500 fires ONLY at confidence ~86, the '
      + 'highest-confidence cohort in the system, and lost 36 of 39 replayed trades with 21 '
      + 'consecutive losses since 2024-01-31. Nothing watches for confidence that is '
      + 'inverted rather than merely weak. The live learning engine cannot see it — its '
      + 'floor is 5 closed trades per setup and SPX has one.',
  },
];

/** Which of the seven an employee failed to declare. A gap is a finding, not a blank. */
function missingFields(employee) {
  const required = ['brain', 'context', 'tools', 'skills', 'loop', 'memory', 'playbook', 'clock'];
  return required.filter(field => {
    const value = employee[field];
    if (value == null) return true;
    if (Array.isArray(value)) return false;   // an empty list is a real answer: "none"
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return String(value).trim() === '';
  });
}

function roster() {
  const employees = ROSTER.map(e => ({ ...e, missingFields: missingFields(e) }));
  const employed = employees.filter(e => e.status === EMPLOYED);
  return {
    employees,
    counts: {
      total: employees.length,
      employed: employed.length,
      proposed: employees.length - employed.length,
      withModel: employed.filter(e => !/^none/.test(e.brain)).length,
      deterministic: employed.filter(e => /^none/.test(e.brain)).length,
      incomplete: employees.filter(e => e.missingFields.length).length,
    },
    feedsTheGate: false,
    whatThisIs:
      'Who is employed, to do what, on which box, reading what, writing where, and on whose '
      + 'clock. A DESCRIPTION, not a scheduler — nothing here spawns an agent, runs a skill, '
      + 'calls a tool or places a trade. PROPOSED means specified and not employed; never '
      + 'quote one as something the system does.',
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { roster, ROSTER, EMPLOYED, PROPOSED };
