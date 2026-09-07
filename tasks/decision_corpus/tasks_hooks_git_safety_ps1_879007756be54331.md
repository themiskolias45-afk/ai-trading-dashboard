---
decision_key: 879007756be54331
source: tasks/hooks/git-safety.ps1:134
status: standing
recorded: 2026-09-02T17:54:29.703Z
---

# STANDING DECISION

These files must NEVER enter the index. The post-edit hook already blocks writing

Governs: `$secretFilePatterns = @(`

## The reasoning as recorded

0. Secret file staging: block `git add` on credential files before they reach a commit.
   These files must NEVER enter the index. The post-edit hook already blocks writing
   them, but a manual `git add` in a shell bypasses that hook entirely.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
