Architect a solution before writing any code. Usage: /plan [what to build or fix]
$ARGUMENTS is the task. If empty, ask: "What are we building?"

═══ STEP 1 — UNDERSTAND ═══
Search first — does any part of this already exist?
  Grep server/index.js for the feature name / endpoint / function
  Grep dashboard/ for any related UI component
  If found → note what exists and what needs changing vs what needs creating

Read EVERY file that will be touched — front to back.
For each file: what does it do, what's its structure, where does the new feature fit?

═══ STEP 2 — DESIGN ═══
Think through and answer each question before writing the plan:
  - What is the minimal architecture that solves this completely?
  - What data does it need? Where does that data come from? Where does it go?
  - What are the failure modes? null, empty, network down, API non-200, file missing
  - What existing code can be reused vs written fresh?
  - What is the exact implementation order (dependency order)?
  - Does this touch signal logic, risk gate, lot sizing, or stop calculation? → flag HIGH RISK

═══ STEP 3 — WRITE THE PLAN ═══
Output this structure exactly:

---
PLAN: [feature name]
---
WHAT: [2 sentences max — what it does and why]

RISK LEVEL: LOW / MEDIUM / HIGH
[If HIGH: state exactly which trading logic is affected]

FILES TO CHANGE:
• [file] — [what changes and why — one line each]

FILES TO CREATE:
• [file] — [what it contains — one line each]

IMPLEMENTATION ORDER:
1. [first — why first, what it enables]
2. [second]
3. [etc.]

INTERFACES (if multiple files interact):
• [function/endpoint name]: [input shape] → [return shape]

FAILURE CASES HANDLED:
• [what could go wrong] → [how it's handled]

COMPLEXITY: Simple (1 file, <30 min) / Medium (2-3 files) / Complex (4+ files, use /engineer)

PARALLEL? [YES — these workstreams are independent: A, B / NO — must be sequential]
---

═══ STEP 4 — TASK CREATION ═══
If complexity is Medium or Complex:
  Create a TaskCreate with:
    - Title: [feature name]
    - Description: [WHAT from the plan]
    - Status: pending
  If parallel: create one sub-task per workstream.

═══ STEP 5 — WAIT FOR APPROVAL ═══
After outputting the plan, say: "Approve to build? (Y/N)"
Do NOT touch any file until approved.
If approved:
  - Update the task status to in_progress
  - If Complex → recommend using /engineer for parallel build
  - If Simple/Medium → build step by step, verify each step before the next
