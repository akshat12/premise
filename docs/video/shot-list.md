# Shot list

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

## Shots

| # | Script row | Do this | Check before you speak |
|---|---|---|---|
| 1 | 0:00 Hook | Load the address. Press `Space` at once to pause. Click **A/B** in the top bar. | The headline sentence and the first rows (3 / 0 and 11 / 0) are on screen. The pill says "Replay 1× · paused". |
| 2 | 0:30 Dispatch | Click **Lanes**. Press `⌘K`, type `dispatch`, press `Enter`. In the panel, type `300` into "Workload Intents". **Do not press the Dispatch button.** Press `Esc`. Click the **Play again** button (the circular arrow). Start speaking as you click. | Twelve tasks are ticked in the panel. After Play again the pill says "Replay 1×" and strips start to appear. |
| 3 | 0:45 Premise break | Keep it playing. About 25 seconds after Play again, T01 turns green and three strips turn red. Press `Space` within a few seconds. Move the pointer onto the `verifySession` row at the top of the ledger and leave it there. | T02, T03 and T11 are red with `verifySession` struck through. "Broken builds on trunk" is 0. If you paused late and a strip already says "re-deriving": click Play again, `Space`, then `→` twice. |
| 4 | 1:45 Re-derive | Click the **T02** strip (the drawer opens). Press `Space` to resume. Watch T02: "rebase ✗" after about 7 seconds, green with R1 after about 30; T03 and T11 by about 50. When you reach "One honest note", press `→` once, and `Space` after the pill has gone. | The drawer's header shows the two race rows. After the jump the top bar shows "⏩ 5s compressed" for three seconds. |
| 5 | 3:15 Collision, trespass, stalemate | Press `Esc`. Click **Play again**, press `Space` at once, press `→` once. Click the **T05** strip. | The card "Two Intents both want computeTotal" is at the top right. T05 is amber, "quarantined", and its strip shows a pencil chip for `taxFor`. The drawer says "Changes taxFor". Its timeline reads, newest first: "Asked a person", "Ledger said Wait for computeTotal", "Quarantined: Edited without a claim", then further down "Ledger said Split for computeTotal, taxFor". |
| 6 | 4:00 Drawer | Press `Esc`. Press `→` once (the premise break). Click **T02**. Hold the pointer over the struck-through `verifySession` chip on T02's strip until its tooltip shows. | The middle column has the three headings: Asserted, Derived, Observed, each with its one-line meaning. The asserted row is struck through with the reason under it. |
| 7 | 5:00 Scale | Press `Esc`. Press `→` ten times (to the end). Click **Scale**. | 300, 306, 53.1, 0. The chart runs to 4:58. The Artifacts line says "Operations ≈ 912" and "$0.14". |
| 8 | 6:00 Architecture and code | Second browser tab: `docs/architecture.svg` (open the file, or the README on GitHub scrolled to "Architecture"). Then the editor, light theme, 16 px type or larger, no side bars: `src/worker/gate/invalidate.ts` scrolled to `export async function invalidateWith` (line 141); then `src/worker/gate/rederive.ts` scrolled to `export async function startRace` (line 165). | The whole diagram fits without scrolling. Each code view shows the function's signature and its first twenty lines. |
| 9 | 6:40 A/B | Back to the first tab. Click **A/B**. Scroll down until the amber "What it cost" paragraph is at the top and the "False-positive rate" row (n/a, 76%) is visible. | Both are on screen together. |
| 10 | 7:30 End frame | Open `docs/video/end-frame.html?repo=github.com/OWNER/premise` in the browser (replace OWNER with the account the repo is published under). Hold five seconds after the last word. | The repo address on the frame is the real, public one. |
