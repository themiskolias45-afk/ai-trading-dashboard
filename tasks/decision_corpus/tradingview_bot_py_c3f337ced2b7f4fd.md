---
decision_key: c3f337ced2b7f4fd
source: tradingview_bot.py:2138
status: standing
recorded: 2026-09-02T17:54:29.703Z
---

# STANDING DECISION

`t.strip() == name` can NEVER be true, even for a row in full view.

Governs: `searched = False`

## The reasoning as recorded

SEARCH, never scan the rendered rows. Two independent reasons, both measured
against the live dialog on 2026-08-24, and either alone was fatal:

  1. THE LIST IS VIRTUALISED. The scroll container measured scrollHeight 2866
     against clientHeight 467, so all_inner_texts() returned only the ~11 rows
     that happened to be rendered. A script further down the list simply was
     not there to be found, and the code reported it "not a saved script yet".
  2. EVERY CHARACTER IS ITS OWN ELEMENT. The title comes back as
     'J\nA\nR\nV\nI\nS\n \nD\na\ni\nl\ny\n \nP\nl\na\nn' — TradingView renders
     per-character spans, so all_inner_texts() joins them with newlines and
     `t.strip() == name` can NEVER be true, even for a row in full view.

That pair is the whole reason fourteen days of saving never reached the chart:
every run concluded the script did not exist, took the create path, and made
another orphan. Typing the name into the dialog's own Search box makes the
server do the matching, and squash() makes the comparison survive the markup.

This is a STANDING DECISION. If a change contradicts it, surface the conflict and
get an explicit answer. Do not override it and do not re-derive it from first
principles — the reasoning above is what a previous attempt already cost.
