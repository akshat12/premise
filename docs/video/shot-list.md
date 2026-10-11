# Shot list

> **Revised Oct 11.** The script was rewritten after the review (cold open on the premise break, six minutes, the Tape view and T11's drawer added, no rewind, no dispatch panel, no code shot). The set-up below still holds. The table of `→` stops and the times in it describe the Oct 9 recording and must be read again from the new recording once it is made. The shots are listed afresh under "Shots (Oct 11 script)"; the older table after it is kept only for its checks.

One shot per row of `script.md`. Every shot except 8 and 10 is the same page.

## Set-up, once

- **Browser:** Chrome, a new window with nothing else in it. Hide the bookmarks bar. Zoom 100% (`⌘0`).
- **Size:** the page area must be exactly **1440×900**. Easiest way: open DevTools, turn on the device toolbar (`⌘⇧M`), choose "Responsive", type 1440 × 900 and 100%, then undock DevTools into its own window so it is out of the picture.
- **Theme:** nothing to set. The app is light whatever the system appearance is.
- **Address:** `https://premise.akshatdivekar.workers.dev/?demo=main`. If the network is bad, use the offline copy (see `stage-10min.md`, "Offline fallback") and the same keys.
- **Recording:** capture the page area only, 30 frames a second or more. Record the voice separately if you can; it makes retakes of one shot cheap.
- **Keys the page understands in a replay:** `Space` pause or resume, `→` jump to the next key moment, `1` `2` `4` speed, `Esc` close the drawer or a panel, `⌘K` commands, `?` the list of keys.

The `→` key stops at these moments, in this order. A paused replay stays paused after a jump.

| Press | Recording time | What is on screen |
|---|---|---|
| 1st | 0:20 | The stalemate card for T05 and T06 on `computeTotal` |
| 2nd | 0:26 | **The premise break:** T02, T03, T11 red |
| 3rd | 0:57 | T02's race won by the re-derive; T02 landed, R1 |
| 4th | 1:14 | T03's race won by the re-derive |
| 5th | 1:17 | T11's race won by the re-derive |
| 6th | 1:56 | First marker, "⏩ 5s compressed" (shows for 3 seconds) |
| 7th to 11th | 2:54 to 4:33 | Five more markers |
| 12th | 4:35 | The end: 264 landed, everything green |

## Shots (Oct 11 script)

| # | Script row | Do this | Check before you speak |
|---|---|---|---|
| 1 | 0:00 Cold open | Load the address. Press `Space` at once to pause, then `→` until the caption under the top bar begins "T01 NULL landed and changed verifySession". | T02, T03 and T11 are red with `verifySession` struck through. The pill says "paused". |
| 2 | 0:35 What it is | Click **Play again** (the circular arrow). Start speaking as you click. | The pill says "Replay 1×" and strips start to appear. |
| 3 | 1:05 The break | Keep it playing until the three strips turn red, then press `Space`. Rest the pointer on the struck-through `verifySession` chip on T02. | "Broken builds on trunk" is 0. If a strip already says "re-deriving", click Play again and pause sooner. |
| 4 | 1:30 Re-derive | Click the **T02** strip. Press `Space` to resume and watch its strip: "rebase ✗", then green with R1. | The drawer is open on T02. |
| 5 | 2:05 T11 | Press `Space` to pause once T11 is green. Press `Esc`, click **T11**. Point at the timeline line that ends "Every test passed (…)", then at the **Changes** column. Use "Expand" on it if the diff is cramped. | The line reads "Gate turned back the rebased work: its premise no longer holds" and names three kinds of test that passed. |
| 6 | 2:55 Tape | Press `Esc`. Click **Tape**. | The red line and its flag are on screen; three rows stop at it. |
| 7 | 3:20 Ledger | Click **Lanes**. Hover the `computeTotal` row in the ledger rail. | The strips that touch it stay lit. |
| 8 | 3:40 Scale | Press `→` until the caption says the run is over. Click **Scale**. Read the numbers from the screen. | The chart has reached the end of the run. |
| 9 | 4:10 Architecture | Second browser tab: `docs/architecture.svg`. | The whole diagram fits without scrolling. |
| 10 | 4:35 A/B | First tab. Click **A/B**. After the headline, scroll until the amber "What it cost" paragraph is in view. | The three columns read 3, 1, 0 in the first row and 0, 2, 0 of 12 in the second. |
| 11 | 5:35 End frame | Open `docs/video/end-frame.html?repo=github.com/OWNER/premise` (replace OWNER with the account the repo is published under). Hold five seconds after the last word. | The repo address on the frame is the real, public one. |

## Shots (Oct 9 script, superseded)

| # | Script row | Do this | Check before you speak |
|---|---|---|---|
| 1 | 0:00 Hook | Load the address. Press `Space` at once to pause. Click **A/B** in the top bar. | The headline sentence and the first rows (3 / 0 and 11 / 0) are on screen. The pill says "Replay 1× · paused". |
| 2 | 0:30 Dispatch | Click **Lanes**. Press `⌘K`, type `dispatch`, press `Enter`. In the panel, type `300` into "Workload Intents". **Do not press the Dispatch button.** Press `Esc`. Click the **Play again** button (the circular arrow). Start speaking as you click. | Twelve tasks are ticked in the panel. After Play again the pill says "Replay 1×" and strips start to appear. |
| 3 | 0:45 Premise break | Keep it playing. About 25 seconds after Play again, T01 turns green and three strips turn red. Press `Space` within a few seconds. Move the pointer onto the struck-through `verifySession` chip on T02's strip and leave it there: the three stopped strips stay lit and the rest dim. (The ledger's `verifySession` row does the same, but at 1440×900 the stalemate card is covering it at this moment.) | T02, T03 and T11 are red with `verifySession` struck through. "Broken builds on trunk" is 0. If you paused late and a strip already says "re-deriving": click Play again, `Space`, then `→` twice. |
| 4 | 1:45 Re-derive | Click the **T02** strip (the drawer opens). Press `Space` to resume. Watch T02: "rebase ✗" after about 7 seconds, green with R1 after about 30; T03 and T11 by about 50. When you reach "One honest note", press `→` once, and `Space` after the pill has gone. | The drawer's header shows the two race rows. After the jump the top bar shows "⏩ 5s compressed" for three seconds. |
| 5 | 3:15 Collision, trespass, stalemate | Press `Esc`. Click **Play again**, press `Space` at once, press `→` once. Click the **T05** strip. | The card "Two Intents both want computeTotal" is at the top right. T05 is amber, "quarantined", and its strip shows a pencil chip for `taxFor`. The drawer says "Changes taxFor". Its timeline reads, newest first: "Asked a person", "Ledger said Wait for computeTotal", "Quarantined: Edited without a claim", then further down "Ledger said Split for computeTotal, taxFor". |
| 6 | 4:00 Drawer | Press `Esc`. Press `→` once (the premise break). Click **T02**. Hold the pointer over the struck-through `verifySession` chip on T02's strip until its tooltip shows. The drawer's middle column is too short to show all three headings at once: scroll it as you name them (Asserted is at the top, then Derived, then Observed). | The middle column starts with Asserted, its row struck through with the reason under it; Derived and Observed follow as you scroll, each with its one-line meaning. |
| 7 | 5:00 Scale | Press `Esc`. Press `→` ten times (to the end). Click **Scale**. | 300, 306, 53.1, 0. The chart runs to 4:58. The Artifacts line says "Operations ≈ 912" and "$0.14". |
| 8 | 6:00 Architecture and code | Second browser tab: `docs/architecture.svg` (open the file, or the README on GitHub scrolled to "Architecture"). Then the editor, light theme, 16 px type or larger, no side bars: `src/worker/gate/invalidate.ts` scrolled to `export async function invalidateWith` (line 141); then `src/worker/gate/rederive.ts` scrolled to `export async function startRace` (line 165). | The whole diagram fits without scrolling. Each code view shows the function's signature and its first twenty lines. |
| 9 | 6:40 A/B | Back to the first tab. Click **A/B**. Scroll down until the amber "What it cost" paragraph is at the top and the "False-positive rate" row (n/a, 76%) is visible. | Both are on screen together. |
| 10 | 7:30 End frame | Open `docs/video/end-frame.html?repo=github.com/OWNER/premise` in the browser (replace OWNER with the account the repo is published under). Hold five seconds after the last word. | The repo address on the frame is the real, public one. |
