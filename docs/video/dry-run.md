# Dry run, before recording

Do this once, the day before recording, and again in the hour before. Tick every box. If one fails, fix it or switch to the fallback named in it before recording anything.

The deployed Worker is `https://premise.akshatdivekar.workers.dev`. Commands that call it read the admin token from `.env.deployed`; never type it where the camera can see it.

## The system

- [ ] **A fresh reset works.** `curl -s -X POST https://premise.akshatdivekar.workers.dev/api/admin/reset-demo -H "x-admin-token: $(grep '^ADMIN_TOKEN=' .env.deployed | cut -d= -f2-)"` answers `{"ok":true,"trunk":"trunk-…"}`.
- [ ] **A live run succeeds.** `npm run demo -- --url https://premise.akshatdivekar.workers.dev --workload 40`. On the page that opens: T01 lands first; Agents 2, 3 and 11 are stopped (their lanes turn red, with an orange line through their rows) and come back landed with an R1 stamp; all twelve agent rows end "landed"; "Broken builds on trunk" and "Human merges" are both 0. It takes about two minutes. *If it does not finish: the video uses the recorded run for every shot anyway. Note what happened and carry on.*
- [ ] **The gate is idle afterwards.** `curl -s https://premise.akshatdivekar.workers.dev/api/gate` shows `"queue":[]` and `"busy":false`.
- [ ] **The demo recording plays.** Open `https://premise.akshatdivekar.workers.dev/?demo=main` in a private window. It opens on "Step 01 / 07". Press `→` until "Step 04 / 07": Agents 2 and 4 are orange, Agent 3 is not. Press `→` three more times: "Everything landed. Nothing broken reached trunk." Then open `/?demo=scale` and check the larger demo recording plays too, and `/?demo=live`: its top bar says "Replay · live model · real Artifacts" and its last step reads "The run is over. One problem reached trunk."
- [ ] **The two panels under the story show what the script says.** On the front page, scroll down past the four rows. Compared: the three cards read 3, 1 and 0 "problems reached trunk" and 0, 2 and 0 "tasks handed back to a person". At scale: the figures read 306, 266, 61 and 0; under **More numbers**, "309 forks and 315 pushes" and "36 Intents wanted a symbol … 136 times". *If the Compared rows differ, the comparison was re-run with a different scenario: stop and find out why.*
- [ ] **The offline copy plays.** `npm run demo:offline`, then `http://localhost:4173/?demo=main` with Wi-Fi off. Same keys, same result.

## The picture

- [ ] The page area is exactly 1440×900, zoom 100%, bookmarks bar hidden, no other tabs in the window.
- [ ] At step 6, the tallest step, the four rows, the counter strip, the readout under Agent 4 and the key all fit without a scrollbar. The top bar is not clipped.
- [ ] Notifications are off (Do Not Disturb), the Dock is hidden, the pointer is visible.
- [ ] `docs/video/end-frame.html?repo=…` shows the real repo address.

## The sound

- [ ] Record ten seconds and listen on headphones: no clipping, no hum, room echo acceptable.
- [ ] Speech peaks between −12 and −6 dB. Keep the same distance from the microphone for every shot.
- [ ] No music under the voice.

## The read

- [ ] Read `script.md` aloud once against `/?demo=main`, with a stopwatch, doing the keys from `shot-list.md`. **It must land between 5:45 and 6:45, and never under 5:00.** Write the time here: ______
- [ ] Nothing in the read says "merge queue", "pull request", "PR" or "branch".
- [ ] "Premises are the early warning. The gate is the guarantee." is said exactly once, in the live-model row.

## After recording

- [ ] The finished video is between 5 and 10 minutes long. Write the length here: ______
- [ ] Watch it once from start to finish at normal speed, on a laptop screen, with sound. The small uppercase labels are readable.
- [ ] The admin token is not visible anywhere in it (the dispatch panel masks it; check the terminal was never on screen).
