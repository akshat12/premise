# Shot list

One shot per row of `script.md`. Shots 1 to 7 and 9 are the same page; 8 is the diagram, 10 is the live-model replay and 11 is the end frame.

## Set-up, once

- **Browser:** Chrome, a new window with nothing else in it. Hide the bookmarks bar. Zoom 100% (`⌘0`).
- **Size:** the page area must be exactly **1440×900**. Easiest way: open DevTools, turn on the device toolbar (`⌘⇧M`), choose "Responsive", type 1440 × 900 and 100%, then undock DevTools into its own window so it is out of the picture.
- **Theme:** nothing to set. The app is light whatever the system appearance is.
- **Address:** `https://premise.akshatdivekar.workers.dev/`. If the network is bad, use the offline copy (see `stage-10min.md`, "Offline fallback") and the same keys.
- **Recording:** capture the page area only, 30 frames a second or more. Record the voice separately if you can; it makes retakes of one shot cheap.
- **Keys the page understands in a replay:** `→` Next, `←` Back, `Space` play or pause, `Esc` close the details panel, `⌘K` everything else.

## Shots

The front page is the story: a sentence at the top with **Back**, **Next** and **Play**, a strip of five counters, and four rows under it. The seven segments beside "Step 0n / 07" jump straight to a step. The page opens on step 1, held.

| # | Script row | Do this | Check before you speak |
|---|---|---|---|
| 1 | 0:00 Cold open | Load `https://premise.akshatdivekar.workers.dev/`. Click the fourth segment. | "Step 04 / 07". Agents 2 and 4 are marked in orange and say "stopped"; Agent 3 is not. The counters read 4, 2, 0, 1, 0. |
| 2 | 0:35 What it is | Click the first segment, speak, then press `→` once. | "Step 01 / 07", then "Step 02 / 07": every row shows a pencil line and an eye line. The top bar says "Replay · scripted agents · real Artifacts". |
| 3 | 1:05 The break | Press `→`, wait for the tape to stop, press `→` again. | The orange flag reads "AGENT 1 LANDED · VERIFYSESSION CHANGED". |
| 4 | 1:30 Re-derive | Press `→`. | "Step 05 / 07". Agent 2's row has a blue "re-derived" bar and a green tick. |
| 5 | 2:05 Agent 4 | Press `→`. Then click Agent 4's row and point at the **Changes** column; drag the panel's top edge up if the diff is cramped. | "Step 06 / 07". The readout under Agent 4's row has three readings that passed and "Its premise: Failed". |
| 6 | 2:55 The end | Press `Esc`, then `→`. | "Step 07 / 07": "Everything landed. Nothing broken reached trunk." The counters read 4, 2, 2, 4, 0. |
| 7 | 3:10 At scale | Click **At scale**. | The green-edged note at the top says these numbers are from a larger run. The figures read 309, 315, 61.4. The ledger line reads "36 Intents … 136 times". |
| 8 | 3:45 Architecture | Second browser tab: `docs/architecture.svg`. | The whole diagram fits without scrolling. |
| 9 | 4:10 Compared | First tab. Click **Compared**. After the headline, scroll until the amber "What it cost" paragraph is in view. | The three columns read 3, 1, 0 in the first row and 0, 2, 0 of 12 in the second. |
| 10 | 5:05 Live model | Open `https://premise.akshatdivekar.workers.dev/?demo=live` and click the last segment. | The top bar says "Replay · live model · real Artifacts". The sentence reads "The run is over. One problem reached trunk." The last counter reads 1. |
| 11 | 5:55 End frame | Open `docs/video/end-frame.html?repo=github.com/OWNER/premise` (replace OWNER/premise with the public repo). Hold five seconds after the last word. | The repo address on the frame is the real, public one. |
