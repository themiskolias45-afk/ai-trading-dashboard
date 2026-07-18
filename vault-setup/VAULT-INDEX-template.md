---
status: active
project: meta
type: index
---
# VAULT INDEX

Read this file at the start of every conversation. It has two jobs: **the profile of the person you work for** (who I am, how I think, how to work with me) and **the map of this vault** (the structure, the indexes, and the rules for maintaining it). Your own identity is not here — that lives in the boot file (CLAUDE.md), which survives compaction.

(**AI:** if you are reading this file and any [FILL IN: ...] markers remain, this vault isn't set up yet — offer to interview the person and complete it for them.)

---

## Vault location

This vault lives at `[FILL IN: your vault's full path — e.g. /Users/you/Documents/Brain on Mac, C:\Users\you\Documents\Brain on Windows]`.

---

## Who I Am

[FILL IN: your name and whatever context you want the AI to have. First person, conversational, concise.]

## Key People

- **[[Name]]** — [FILL IN: who they are and their role to you]

## [FILL IN: Project 1 name]

[FILL IN: what it is, what stage it's in, key tools/platforms. First person.]
- **Status:** [FILL IN: Active / Maintenance / Planning]

## Vault Structure

```
00 - Inbox          ← Capture everything, sort later
01 - Daily Notes    ← Dated logs of what got done, one file per day
02 - [FILL IN]      ← [FILL IN: brief description]
[N] - Personal      ← Life outside work
[N] - Archive       ← Completed projects and old notes
[N] - Resources     ← Cross-project reference material, templates, Jobs
```

## What's Active Right Now

All open work lives in one note: [[Active Priorities]].

## My Preferences for Working with AI

- **Plain language, no jargon, and be direct.** Don't hedge or over-qualify.
- **Don't settle for half-finished work.** Do it right the first time.
- **Be a partner, not a yes-man.** Argue your position when you think I'm wrong.
- **One question at a time — then stop.** Wait for my actual answer before continuing.
- **Never suggest stopping.** I decide when we're done.
- **Pull me back from rabbit holes.** Flag tangents and ask pursue or park.
- **Most of my guidance is guidelines, not laws.** Reserve "Locked" for true invariants.
- **I drive the trust-and-access ramp.** Never propose expanding your own access.

[FILL IN: add your own preferences here]

---

## How My Memory Works (for the AI)

This vault is your memory. It is external and effectively unlimited. Do not try to hold all of it at once. Hold only what the current task needs, and trust that everything else is one search away.

---

## Vault Rules for AI

### Frontmatter and Wikilinks

Every note MUST have YAML frontmatter. Infer the values — never ask me what they should be.

```yaml
---
status: active
project: [project-slug]
type: plan
---
```

**status:** `active` | `completed` | `parked` | `idea` | `archived`
**type:** `index` | `reference` | `guide` | `plan` | `log`

### Folder Indexes

Every folder with substantial content gets an index note named after the folder. Update it in the same pass as any note created, renamed, moved, or changed.

### Checkpoint Persistence

Whenever something changes a future session needs to know, persist it — update the relevant note and today's daily note. The vault is the memory; keeping it current is maintaining the system.

### Daily Notes

Daily notes live in `01 - Daily Notes/`, filename `YYYY-MM-DD.md`. Create every daily note FROM `01 - Daily Notes/Daily Note Template.md`. If today's exists, append a new session section — don't overwrite.

**Trigger:** When I signal I'm done ("calling it," "goodnight"), offer to create or update today's daily note. At the start of every conversation, check yesterday's note and backfill if you have missing context.

### Living Profile

Update **Key People · How I Think · Health · Personal Interests · Beliefs · Daily Routine** as you learn through conversation. Log every update in the daily note under "Profile Updates." Never update Who I Am, project sections, or Vault Rules on your own initiative.
