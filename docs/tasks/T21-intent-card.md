# T21: Intent card, chips and drawer (premise sources, 3-line why)

## Goal
Make an intent readable in under 3 seconds:
- **Card:** what it is doing, what it **changes**, and what it **relies on**.
- **Drawer:** where each premise came from, and why the agent did what it did.

## Read first
- **`docs/UI.md` (design brief: light mode, flight strips, motion, copy, self-critique). Read it first. It wins on visual details.**
- `CLAUDE.md`: vocabulary rules
- `docs/SPEC.md`: UI section
- `src/ui/lib/reduce.ts`
- T20 components

## IntentCard (rendered inside the Intent Flow.Node via `render`)
- **Line 1:** a short goal (truncate at 60 characters), plus a status badge.
- **Line 2:** ✏️ **changes** chips, one per claim. The label is the symbol name. Add a small "if" suffix when the claim is in interface mode.
- **Line 3:** 👁 **relies on** chips.
  - Show at most 4. If there are more, show "+N".
  - Sort so that asserted premises come first, then broken ones.
  - Chip colours:

| Premise | Colour |
|---|---|
| Holding | green |
| Broken | red, with a strikethrough on the name |
| Asserted | a ⚑ glyph (behavioural) |

- **Re-derive race:** when a race is running, show a mini two-row indicator.
  - Rows: "rebase" and "re-derive".
  - Each row shows pending ⏳, pass ✓ or fail ✗.
  - Highlight the winner.
- **Shared chips:** when the same symbol appears as ✏️ on one intent and 👁 on another, give both chips a matching subtle outline colour. This is how collisions show without cross-lane edges.

## Drawer (bottom sheet when an intent is selected)
Three columns.

**1. Why**
- At most 3 lines from `why`.
- Below them, rejected alternatives in muted text.

**2. Relies on**
- The full premise list, grouped by source: **observed** (it read this), **derived** (its code references this), **asserted** (it depends on this behaviour).
- Each row shows the symbol, the short surface hash, and its state.
- A broken row shows `brokenBy.reason` and links to the intent that caused it.

**3. Timeline**
- This intent's events (status changes, gate results, race results), newest first.
- Each has a relative timestamp.

## Copy rules
- Use exactly "changes" and "relies on".
- Never use "PR" or "branch".
- When an intent is stale, the card subtitle is: "A premise broke: re-deriving on new trunk".

## Also in this task
- **The premise-break moment** from `docs/UI.md`: the red-pen line drawn with an SVG stroke animation, the band crossfade and the annotation. Respect `prefers-reduced-motion`.
- **Cross-highlight** on chip or ledger hover.
- **Chip tooltips**: decl, plain-language source and short hash.
- **Keyboard:** `j`/`k`/`Enter`/`Esc`.

## Acceptance
```
npm run typecheck && npm test   # add component tests with @testing-library/react ONLY if already approved; otherwise reducer-level tests for chip sorting/grouping helpers in src/ui/lib/chips.ts
npm run dev   # replay: select t02 -> drawer shows asserted premise "verifySession throws SessionExpiredError…" turning red with reason, race indicator shows rebase ✗ re-derive ✓
```
Save a screenshot as `docs/screens/t21.png`.
