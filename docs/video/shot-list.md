# Shot list

One shot per row of `script.md`. Shots 1 to 8 are the same page, the **Demo** tab: the story, then two panels under it. 9 is the diagram, 10 is the live-model replay and 11 is the end frame.

## Set-up, once

- **Browser:** Chrome, a new window with nothing else in it. Hide the bookmarks bar. Zoom 100% (`⌘0`).
- **Size:** the page area must be exactly **1440×900**. Easiest way: open DevTools, turn on the device toolbar (`⌘⇧M`), choose "Responsive", type 1440 × 900 and 100%, then undock DevTools into its own window so it is out of the picture.
- **Theme:** nothing to set. The app is light whatever the system appearance is.
- **Address:** `https://premise.akshatdivekar.workers.dev/`. If the network is bad, use the offline copy (see `stage-10min.md`, "Offline fallback") and the same keys.
- **Recording:** capture the page area only, 30 frames a second or more. Record the voice separately if you can; it makes retakes of one shot cheap.
- **Keys the page understands in a replay:** `→` Next, `←` Back, `Space` play or pause, `Esc` close the details panel, `⌘K` everything else.

## Shots

The front page is the **Demo** tab. It is the story: a sentence at the top with **Back**, **Next** and **Play**, a strip of five counters, and four rows under it. The seven segments beside "Step 0n / 07" jump straight to a step. The page opens on step 1, held. Under the four rows, in the same scrolling area, are two panels: **Compared** and **At scale**.

| # | Script row | Do this | Check before you speak |
|---|---|---|---|
| 1 | 0:00 Cold open | Load `https://premise.akshatdivekar.workers.dev/`. Click the fourth segment. | "Step 04 / 07". Agents 2 and 4 are marked in orange and say "stopped"; Agent 3 is not. The counters read 4, 2, 0, 1, 0. |
| 2 | 0:35 What it is | Click the first segment, speak, then press `→` once. | "Step 01 / 07", then "Step 02 / 07": every row shows a pencil line and an eye line. The top bar says "Replay · scripted agents · real Artifacts". |
| 3 | 1:05 The break | Press `→`, wait for the tape to stop, press `→` again. | The orange flag reads "Agent 1 landed · verifySession changed". |
| 4 | 1:30 Re-derive | Press `→`. | "Step 05 / 07". Agent 2's row has a blue "re-derived" bar and a green tick. |
| 5 | 2:05 Agent 4 | Press `→`. Then click Agent 4's row and point at the **Changes** column; drag the panel's top edge up if the diff is cramped. | "Step 06 / 07". The readout under Agent 4's row has three readings that passed and "Its premise: Failed". |
| 6 | 2:55 The end | Press `Esc`, then `→`. | "Step 07 / 07": "Everything landed. Nothing broken reached trunk." The counters read 4, 2, 2, 4, 0. |
| 7 | 3:10 Compared | Scroll down in the page (not the browser window: the story stays at the top) until the **Compared** panel fills the view. Then scroll until "What Premise costs" is in view. | The three cards read 3, 1 and 0 "problems reached trunk", and 0, 2 and 0 "tasks handed back to a person". |
| 8 | 4:05 At scale | Scroll on to the **At scale** panel. Click **More numbers**. | The headline reads "12 agents and 294 scripted Intents, through one gate." The four figures read 306, 266, 61, 0. Under More numbers: "309 forks and 315 pushes", and "36 Intents wanted a symbol … 136 times". |
| 9 | 4:40 Architecture | Second browser tab: `docs/architecture.svg`. | The whole diagram fits without scrolling. |
| 10 | 5:05 Live model | Open `https://premise.akshatdivekar.workers.dev/?demo=live` and click the last segment. | The top bar says "Replay · live model · real Artifacts". The sentence reads "The run is over. One problem reached trunk." The last counter reads 1. |
| 11 | 5:55 End frame | Open `docs/video/end-frame.html?repo=github.com/OWNER/premise` (replace OWNER/premise with the public repo). Hold five seconds after the last word. | The repo address on the frame is the real, public one. |
