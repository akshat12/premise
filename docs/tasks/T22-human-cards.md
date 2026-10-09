# T22: Human cards (stalemate and fallback) and the dispatch panel

## Goal
The human's whole job is to dispatch work and settle the rare escalation. Make both one click.

## Read first
- `CLAUDE.md`
- `src/shared/events.ts`: `human.needed` and `human.resolved`
- `src/worker/routes/*`: `POST /api/human/:id` and `POST /api/dispatch`
- T20 and T21 components

## Components

### `HumanCard`
A toast-style card stack in the top-right corner, with one card per open `human.needed` event.

- **Stalemate card.**
  - Title: "Two intents both want `computeTotal`".
  - Shows both goals.
  - Buttons: **Wait**, **Split** and **Depend**, each with a one-line explanation under it.
- **Fallback card.**
  - Title: "Re-derive failed twice".
  - Shows the last gate errors, at most 3 lines.
  - Buttons: **Retry** and **Abandon**.
- **Clicking a button:**
  1. POST `/api/human/:id`.
  2. Show an optimistic resolved state.
  3. The card closes when `human.resolved` arrives.
- **Replay mode:** the buttons are disabled. A fixture `human.resolved` event closes the card.

### `DispatchPanel`
A left slide-over opened by a "Dispatch" button in the top bar.

- Lists the tasks from `GET /api/tasks`, with checkboxes. All are selected by default.
- Has a "Workload agents" number input (0–500) and a seed field.
- **Run:**
  1. POST `/api/dispatch`.
  2. If the workload count is greater than 0, then POST `/api/admin/workload`.
- **Admin token:** entered once and kept in `sessionStorage`, wrapped in try/catch. It is never in the URL and never logged.

## Acceptance
```
npm run typecheck && npm test
npm run dev (live, REPO_STORE=memory, LLM=scripted)   # dispatch 12 tasks + 20 workload from the UI; a stalemate card appears for the two computeTotal tasks; clicking Split resolves it and both proceed
```
Save a screenshot as `docs/screens/t22.png`.
