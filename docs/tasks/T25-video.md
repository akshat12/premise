# T25: Video script, dry run and submission checklist

## Goal
Produce everything the humans need to record the 5–10 minute video and submit before **Oct 14, 11:59 PM PDT**. The code is done by this point.

## Read first
- `docs/SPEC.md`: Video (premise break first)
- `docs/ab-results.md`
- `README.md`

## Deliverables

### 1. `docs/video/script.md`
A two-column script with timestamps: **what's on screen** and **what is said**. Target about 8 minutes, in this order:

| Time | Beat |
|---|---|
| 0:00 | Hook: the A/B numbers, split screen. |
| 0:30 | Dispatch 12 tasks + 300 workload agents. |
| 0:45 | **Premise break.** `verifySession` now returns null. 3 intents go red. tsc stays green and there is no text conflict. |
| 1:45 | **Re-derive.** The rebase fails the assertion and the re-derive goes green. Show the ⏩ marker. |
| 3:15 | 30 s on collision → Split, trespass → quarantine, and the stalemate card. |
| 4:00 | Drawer: premise sources. |
| 5:00 | Scale view. |
| 6:00 | 20 s of architecture, then 20 s of Worker code: show `invalidate.ts` and `rederive.ts`. |
| 7:00 | A/B results, including the false-positive rate. |
| 7:30 | End frame: tagline, repo URL, "Built on Cloudflare Workers + Artifacts". |

Script rules:
- Use only the vocabulary words.
- Never say "merge queue".
- Say once, plainly: "Premises are the early warning; the gate is the guarantee."

### 2. `docs/video/shot-list.md`
For each shot list:
- The exact URL, for example `/?demo=main`.
- The keypresses (→ jumps).
- The browser size (1440×900).
- Zoom level and theme.

### 3. `docs/video/dry-run.md`
A checklist:
- A fresh `reset-demo`.
- A live run succeeds.
- The recorded run is replayed.
- Audio levels.
- Total length is between 5 and 10 minutes.

### 4. `docs/SUBMISSION.md`
A checklist with links:
- [ ] Video uploaded (unlisted is fine). Length is between 5 and 10 minutes.
- [ ] The public GitHub repo has a LICENSE (MIT), the README and run instructions.
- [ ] The deployed URL works in a private window. `/?demo=main` works without auth.
- [ ] Every entrant is a US or Canada resident and 18 or older. One submission per entrant.
- [ ] Submitted at https://www.cloudflare.com/git-competition/submit before Oct 14, 11:59 PM PDT. Target Oct 14, 6 PM for a safety margin.
- [ ] Stage fallback for Oct 21: the recorded run plays offline from a local build (`npm run build && npx vite preview`).

### 5. Live-stage variant
`docs/video/stage-10min.md`: a 10-minute live version with a "what if it fails" branch. If the live run stalls, switch to `/?demo=main`.

## Acceptance
- The human reads the script aloud once against `/?demo=main`, and it fits between 7:30 and 9:00.
- Every checklist item in `SUBMISSION.md` has an owner and a time.
