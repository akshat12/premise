# T20: UI shell, counters and Kumo Flow lanes (fixture-driven)

## Goal
Build the main screen from `ViewState` (T04 reducer). It plays `src/ui/fixtures/sample-run.json` in replay mode, so the UI can be built and judged before the backend is finished. Add a toggle for live mode.

## Read first
- `CLAUDE.md`: Kumo facts. **Flow has no onClick, no edge labels and no cross-lane edges.**
- `docs/SPEC.md`: "UI" and "Video"
- `src/ui/lib/reduce.ts`
- `src/ui/lib/useEventStream.ts`
- Kumo docs: run `npx @cloudflare/kumo --help` and read the component docs at `https://kumo-ui.com/components/<name>`. Use Kumo components (`Badge`, `Button`, `LayerCard`, `Tabs`, `Tooltip`, `Meter`, etc.) before writing custom ones. Load the frontend-design skill if it is available.

## Layout (desktop first, 1440×900 for recording; must not break at 1280)

```
┌ Top bar ────────────────────────────────────────────────────────────────┐
│ Premise · trunk @abc123   [Agents 12] [Landed 7] [Broken builds on trunk 0] [Human merges 0] [Premises broken 3]  ● live / ▶ replay  │
├ Center (Flow, horizontal) ─────────────────────────────┬ Right rail ─────┤
│ Backlog ─┬─ Lane: Intent card → Check → Gate → trunk    │ Ledger           │
│          ├─ Lane: ...                                   │ symbol → ✏️ writer│
│          └─ (≤12 agent lanes; workload = 1 aggregate     │          👁 readers│
│             lane "300 workload agents: 241 landed")      │                  │
├ Bottom drawer (opens when an intent is selected) ────────┴──────────────────┤
```

## Components
- **`src/ui/App.tsx`.** Layout, the source toggle (replay or live), and a speed control (1×, 2×, 4×) for replay.
- **`TopBar`.** Counters taken from `metrics`. Render `brokenBuildsOnTrunk` and `humanMerges` in large type. These are the hero numbers.
- **`Lanes`.**
  - `<Flow orientation="horizontal">` containing a Backlog node, then `<Flow.Parallel>` with one `<Flow.List>` per agent intent.
  - Each list's nodes are Intent → Check → Gate → trunk.
  - A node is `disabled` until the intent reaches that stage.
  - Status colour on the Intent node:

| Status | Colour |
|---|---|
| working | neutral |
| waiting | amber |
| stale | red |
| rederiving | violet |
| landed | green |
| escalated | red with a 🔔 |

  - Workload intents collapse into one aggregate lane showing counts.
  - Clicking: put a `<button>` inside the element passed to `render`. Clicking it sets `selectedIntentId`.
- **`LedgerRail`.** Built from `ViewState.ledger`. Sort contested symbols (writer plus readers from other intents) to the top. When a symbol is broken, highlight the reader rows red.
- **Placeholders.** For the T21 (IntentCard, Drawer) and T22 pieces, render simple placeholders. Do not build them here.

## Acceptance
```
npm run typecheck && npm test
npm run dev   # replay mode plays the fixture end-to-end without console errors; counters change; a lane turns red at the premise break and green at landing
```
Take a screenshot (or ask the user for one) at 1440×900 and save it as `docs/screens/t20.png`.
