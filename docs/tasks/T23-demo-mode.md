# T23: Demo mode (record and replay, scale view, A/B panel, time-compress marker)

## Goal
Make the video and the live stage demo **deterministic and safe**:
- Record a real live run and replay it exactly, with honest "⏩ compressed" markers.
- Show the scale view and the A/B results.

## Read first
- **`docs/UI.md` (design brief: light mode, flight strips, motion, copy, self-critique). Read it first. It wins on visual details.**
- `CLAUDE.md`
- `docs/SPEC.md`: Video
- `src/ui/lib/useEventStream.ts`
- `src/worker/ports/llm.ts` (`RecordingLlm`)
- `docs/ab-results.json` from T19

## Pieces

### 1. Record
`scripts/record-run.ts --url $URL --out demo/runs/<name>.json`:
1. Calls `/api/admin/reset-demo`.
2. Dispatches the 12 tasks and N workload agents.
3. Waits until every intent reaches a terminal state.
4. Saves `GET /api/events?since=0` to the output file.

While recording, also wrap the LLM in `RecordingLlm` and save the turns to `demo/scripts/<name>.json`, so a scripted replay can re-run the backend for real (A/B and stage fallback).

### 2. Compress
`scripts/compress-run.ts`:
- Wherever there is no event for more than 4 seconds, cut the gap to 1 second and insert a `demo.marker` event, e.g. `"⏩ 2m 10s compressed"`.
- The UI shows markers as a small pill in the top bar for 3 seconds.

### 3. Demo route
`/?demo=<name>` loads `demo/runs/<name>.json`. Bundle it with Vite's `import.meta.glob`. It plays in replay mode at 1×, and these keys control it:

| Key | Action |
|---|---|
| Space | Pause or resume |
| → | Jump to the next marker or key moment |
| 1 / 2 / 4 | Playback speed |

The key moments are `premise.broken`, `rederive.race` with a winner, `human.needed`, and the final `metrics` event.

### 4. Scale view
A tab next to "Lanes". It shows:
- Big numbers: forks created, pushes, landings per minute, agents active.
- A sparkline of landings per 10 s, built from `trunk.advanced` timestamps.
- The ledger contention count.
- A small line, "Artifacts ops ≈ X; est. cost ≈ $Y". Compute it from the counters using the published Artifacts pricing; fetch the pricing page and cite it in a code comment. If the pricing isn't clear, show the ops count only.

### 5. A/B panel
A tab that renders `docs/ab-results.json`:
- A two-column table: baseline vs Premise.
- The generated headline sentence.
- The false-positive rate, shown honestly.

## Also in this task
- **Final polish pass** over the whole UI against the `docs/UI.md` self-critique list. Compare screenshots t20–t23 side by side and fix inconsistencies in spacing, type and colour.
- **Hard-check light mode** with macOS set to Dark appearance.

## Acceptance
```
npm run typecheck && npm test
npx tsx scripts/record-run.ts --url $URL --out demo/runs/main.json   # completes
npx tsx scripts/compress-run.ts demo/runs/main.json
npm run dev → /?demo=main plays start to finish; → key jumps to the premise break; Scale and A/B tabs render real data
```
