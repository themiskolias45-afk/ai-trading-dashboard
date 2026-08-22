# design/ — the RSI ceiling canvas

Working files for the published design canvas at
**https://claude.ai/code/artifact/cf1269ba-c3ba-4168-ab3f-7577df593fd3**

`Main.dc.html`, `Evidence.dc.html`, `Proof.dc.html` and `canvas.json` are the **source**.
`rsi-ceiling.html` is the built page — 2.2 MB, regenerated from the source every time, and
**gitignored** because it is a build artifact, not something to diff.

## To change the canvas

Edit the `.dc.html` files, then re-seed a **fresh** copy and republish to the same URL —
never edit `rsi-ceiling.html` directly:

```
node "<design-skill base dir>/seed-canvas.mjs" \
  --template "<design-skill base dir>/payload.template.html" \
  --out rsi-ceiling.html --title "RSI Ceiling" \
  --artboard Main.dc.html --artboard Evidence.dc.html --artboard Proof.dc.html \
  --canvas canvas.json
```

The skill base directory is re-extracted by running `/design`; it lives under
`AppData\Local\Temp\claude\bundled-skills\<version>\<hash>\design` and the version moves,
so read it from the skill output rather than pasting the path above.

Publish with the Artifact tool: same file path, `contract: "0.1.31"`, favicon 📐, and
**no** `capabilities` on a republish (omitting keeps what the page already carries).

## What is on it

Three artboards, all numbers measured 2026-08-22, none estimated:

- **The constraint** — 24 of 24 near-misses on `RSI_ABOVE_CEILING`, closest by 1.5 points.
- **The ledger** — every near-miss row, closest first.
- **Proving it changed nothing** — the three replays (A == B byte-identical, A ≠ C).

**Not updated with the capped sweep result.** The canvas still presents the problem and
the safety proof, which are unchanged; the sweep verdict lives on the evidence board
instead — see the `rsiceiling` claim in `server/evidence_register.js`, which is the
system's own memory and reaches both boxes and every agent briefing. If the canvas is
ever refreshed, a fourth artboard carrying that table is the obvious addition.

Styling lifts exact tokens from `dashboard/theme.css` (Inter / JetBrains Mono, `#070b12`
ground, one green `#2bd07c`, one red `#f2555f`, 10px radii) so it reads as the same
system rather than as a separate deck.
