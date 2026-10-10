# Dry run, before recording

Do this once, the day before recording, and again in the hour before. Tick every box. If one fails, fix it or switch to the fallback named in it before recording anything.

The deployed Worker is `https://premise.akshatdivekar.workers.dev`. Commands that call it read the admin token from `.env.deployed`; never type it where the camera can see it.

## The system

- [ ] **A fresh reset works.** `curl -s -X POST https://premise.akshatdivekar.workers.dev/api/admin/reset-demo -H "x-admin-token: $(grep '^ADMIN_TOKEN=' .env.deployed | cut -d= -f2-)"` answers `{"ok":true,"trunk":"trunk-…"}`.
- [ ] **A live run succeeds.** `npm run demo -- --url https://premise.akshatdivekar.workers.dev --workload 40`. On the page that opens: T01 lands first; T02, T03 and T11 go red and come back green with an R1 stamp; all twelve agent strips end "landed"; "Broken builds on trunk" and "Human merges" are both 0. It takes about two minutes. *If it does not finish: the video uses the recorded run for every shot anyway. Note what happened and carry on.*
- [ ] **The gate is idle afterwards.** `curl -s https://premise.akshatdivekar.workers.dev/api/gate` shows `"queue":[]` and `"busy":false`.
- [ ] **The recorded run plays.** Open `https://premise.akshatdivekar.workers.dev/?demo=main` in a private window. Press `Space`, then `→` twice: three red strips. Press `→` ten more times: 264 landed.
- [ ] **Scale and A/B show the script's numbers.** Scale: 300 forks, 306 pushes, 53.1 landings a minute, operations ≈ 912, $0.14. A/B: 3 and 0, 11 and 0, 76%. *If any differ, the recording or the A/B was re-run: change the numbers in `script.md` to match the screen.*
- [ ] **The offline copy plays.** `npm run demo:offline`, then `http://localhost:4173/?demo=main` with Wi-Fi off. Same keys, same result.

## The picture

- [ ] The page area is exactly 1440×900, zoom 100%, bookmarks bar hidden, no other tabs in the window.
- [ ] Twelve agent strips and the workload strip fit without a scrollbar. The top bar is not clipped.
- [ ] Notifications are off (Do Not Disturb), the Dock is hidden, the pointer is visible.
- [ ] The editor for shot 8 is in a light theme at 16 px or larger, with the two files already open at the right lines.
- [ ] `docs/video/end-frame.html?repo=…` shows the real repo address.

## The sound

- [ ] Record ten seconds and listen on headphones: no clipping, no hum, room echo acceptable.
- [ ] Speech peaks between −12 and −6 dB. Keep the same distance from the microphone for every shot.
- [ ] No music under the voice.

## The read

- [ ] Read `script.md` aloud once against `/?demo=main`, with a stopwatch, doing the keys from `shot-list.md`. **It must land between 7:30 and 9:00.** Write the time here: ______
- [ ] Nothing in the read says "merge queue", "pull request", "PR" or "branch".
- [ ] "Premises are the early warning; the gate is the guarantee" is said exactly once.

## After recording

- [ ] The finished video is between 5 and 10 minutes long. Write the length here: ______
- [ ] Watch it once from start to finish at normal speed, on a laptop screen, with sound. Chip text is readable.
- [ ] The admin token is not visible anywhere in it (the dispatch panel masks it; check the terminal was never on screen).
