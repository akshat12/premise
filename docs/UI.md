# Premise UI brief: light mode, calm, delightful

Every UI task (T20–T23) must follow this brief. Read it fully before writing UI code, and re-read the **Self-critique** section before you finish.

## The look: an instrument panel on paper (2026-10-12, supersedes the Type and colour notes below)

The user sent a reference (a dark dashboard with mono uppercase micro-labels, large light numerals, hairline grids and one orange accent) and asked for the same manner in light mode, keeping the rows. Design-canvas board G is the mock; the app follows it. Layout and behaviour are unchanged. Where a section below disagrees with this one, this one wins.

- **Two faces, self-hosted.** Geist Sans for sentences and numerals, Geist Mono for every label. Barlow Condensed and IBM Plex Mono are gone.
- **Labels** (`.label`, and names with `.callsign`) are Geist Mono, uppercase, 11px, letter-spacing 0.08em: statuses, time ticks, the key, tab names, buttons, "Changes" and "Relies on". This replaces "no all-caps labels". Sentences stay in sentence case. Nothing is under 11px.
- **Numerals** (`.figure`) are Geist Sans weight 300 with tabular figures: the counter strip, the gate readout, the Scale and Compared numbers.
- **Paper and ink.** Board `#f3f4f2`, panels `#fbfbfa`, ink `#14181d`, soft ink `#5c6470`, hairlines `#dcdfdb`. Panels have a 1px hairline, a 6px radius and small black corner brackets (`.bracketed`). Bars are square-cornered.
- **One accent.** `--redpen` is now a warm orange-red, `#c2410c`, for text and for fills that carry white text (5.2:1). `--accent-line` `#e8590c` is for lines and dots only. It means a premise broke or a person is needed, and nothing else: the primary button is ink, not blue. Green (landed) and blue (re-deriving) stay, as outlines and small marks.
- **The counter strip** sits under the story in a replay: Agents, Premises broken, Re-derived, Landed, Problems on trunk. It reads the same log as the tape, so the numbers move as the story is stepped through. It shrinks on a short window and is not shown on a phone.
- **The gate readout** on a row whose tests all passed is four readings (Its tests 3 / 3, Reference checks 3 / 3, Existing tests 91 / 91, Its premise Failed) and the premise it had stated.
- **The story bar** says "Step 06 / 07" over square progress segments; the sentence is 34px, weight 500.
- **The top bar in a replay** says "Replay of a recorded run", so nobody takes the page for agents running now.

## The front page is the story on the tape (2026-10-11, supersedes the strip board)

The user found the strip board hard to follow for someone new, and the tape easy. So the Lanes and Ledger views are gone, and the front page is the tape with the run told above it. Where the sections below describe flight strips, lanes, bays or the ledger rail, they describe what was built first and is no longer on screen; the tokens, type, motion rules, copy rules and accessibility floor still hold.

- **One sentence at a time.** The story bar is the biggest text on the page (34px): "Step 03 / 07", a sentence, a line or two under it, Back and Next, and Play. Someone who has never seen Premise should be able to follow the run by pressing Next. The sentences are generated from the event log (`src/ui/lib/story.ts`), never written by hand for a run.
- **Next runs the tape there.** It plays forward to the step in about a second and holds. Back shows the earlier step at once. → and ← do the same; Space plays it through at normal speed.
- **Plain names.** Rows are "Agent 1" to "Agent N" in task order. The callsigns (T02 AUDIT) are not shown. One product word is introduced per step: Intent, premise, trunk, re-derive. A stopped Intent's status word is "stopped", not "stale".
- **Rows grow with the room.** Up to 6 agents: tall rows with the job, "Changes …" (pencil) and "Relies on …" (eye). 7 to 16: one line for the job; what it relies on shows when the row is in focus. More: the name alone.
- **Focus points.** The rows a step is about are tinted and the rest dim. A row whose tests all passed shows what the gate ran: three readings that passed, one that failed, and the premise it had stated.
- **The top bar is three things:** the name, one line saying what Premise is, and the tabs (The story, At scale, Compared). The live board, dispatching and shortcuts are under "More" (⌘K). The live board keeps the fuller bar.
- **The tape glides.** Its playhead follows the replay's clock every frame, on an axis fixed for the whole run.

## What the screen is for
- **Who:** a developer, a lead, or a judge watching dozens to hundreds of agents change one codebase at once.
- **Primary job:** see at a glance what is moving, what broke and why, and when a human is needed. Everything else is secondary.
- **The feeling to aim for:** a calm control room, not a noisy dashboard. Things only call for attention when they need it.

## The one bold idea: intents are flight strips
Air-traffic controllers coordinate many concurrent flights with **flight progress strips**: slim printed strips with a callsign, held in a rack. Controllers annotate them, cross things out in red pen, and slide them from bay to bay as each flight progresses. That is our problem exactly. So:

- **Each intent lane is a strip.** It is rendered through `Flow.Node`'s `render` prop. It is slim, about 56px tall, with a coloured left band (the "holder") and a big **callsign**: the task id plus one word, e.g. `T02 AUDIT`.
- **The Flow stages are the bays:** Intent → Check → Gate → Trunk. As an intent progresses, the next node in its lane goes from `disabled` to enabled. The flight moves bay to bay.
- **A broken premise looks like a controller's red pen.** A red line is drawn through the "relies on" chip, and a short handwritten-style annotation appears on the strip: "verifySession changed: re-deriving".
- **Re-derive gets a blue stamp.** A small `R1` / `R2` stamp in ink blue appears on the strip.

This is the **only** place we spend boldness. Keep everything else (top bar, rails, drawer, dialogs) quiet, using standard Kumo.

## Light mode only
- Force light mode. Set `color-scheme: light` on `:root`.
- Check `https://kumo-ui.com/colors` and the installed Kumo CSS for how it switches modes (a `data-*` attribute or a class on `html`). Pin it to light.
- Do **not** follow `prefers-color-scheme`.
- To verify: switch macOS to Dark appearance. The app must stay light.
- Record the mechanism you used in `docs/DECISIONS.md`.

## Tokens
Use Kumo's semantic tokens for all standard UI: text, borders, buttons, focus. Our own tokens are only for the strip board and the premise states. Define them once as CSS custom properties in `src/ui/theme.css`.

| Token | Hex | Use |
|---|---|---|
| `--board` | `#EDF0F3` | Page canvas behind the lanes: a cool, matte strip rack |
| `--strip` | `#FFFDF4` | Agent intent strip paper (very slightly warm white) |
| `--strip-workload` | `#F2F6FC` | The aggregated workload strip (pale blue) |
| `--ink` | `#17202B` | Primary text on strips (blue-black, AA on all strip colours) |
| `--ink-soft` | `#5A6675` | Secondary text and hashes |
| `--holds` | `#23775A` | Premise holding / landed |
| `--redpen` | `#C42F28` | Premise broken / stale (the red pen) |
| `--bluestamp` | `#2B55C2` | Re-derive stamp and re-derive race row |
| `--amber` | `#8F5B0E` | Waiting / contested (darkened from `#A86A12` on 2026-10-11: 5.7:1 on white, so it passes AA as text) |

Do **not** use Cloudflare orange as a UI accent. Use it only on the Kumo `CloudflareLogo` in the footer ("Built on Cloudflare Workers + Artifacts").

### Status → strip left band
| Status | Band colour | Annotation |
|---|---|---|
| working | `--ink-soft` | |
| waiting | `--amber` | "waiting on T05" |
| stale | `--redpen` | red pen annotation |
| rederiving | `--bluestamp` | stamp |
| landed | `--holds` | |
| escalated | `--redpen` | bell icon plus "needs you" |

**Never rely on colour alone.** Every state also has an icon (Phosphor) and a word.

## Type
- **Superseded 2026-10-12:** see "The look" at the top. The lines below are kept for the record.
- **UI text:** Kumo's default family, which keeps the product consistent with the Cloudflare dashboard.
- **Callsigns and the hero counters:** `Barlow Condensed`, weight 600, `font-variant-numeric: tabular-nums`. Condensed type is what printed strips and ATC displays use, and it lets big numbers fit.
- **Symbol names in chips:** `IBM Plex Mono`, weight 500. These are code identifiers, so a monospace face carries meaning here. Use it nowhere else.
- **Font loading:** self-host with `@fontsource/barlow-condensed` and `@fontsource/ibm-plex-mono`. Do not load them from Google Fonts, because the stage demo must work offline.
- **Scale:** 12 / 13 / 14 / 16 / 20 / 32 / 48 px. Use 48 only for the two hero counters.
- **Labels:** sentence case. No all-caps labels. Callsigns are uppercase because they are identifiers, not labels.

## Layout (1440×900 recording target, must work down to 1280)
```
┌ Top bar (56px): logo-word "Premise" · trunk short sha · counters (hero: Broken builds on trunk, Human merges) · Live pill · Dispatch button ┐
├ Strip board (--board) ─────────────────────────────────────────────┬ Ledger rail (320px, white) ┤
│ Backlog ┬ T02 AUDIT   [✏️ login.ts#handleLogin] [👁 ⚑ verifySession] │ verifySession                │
│         │   → Check → Gate → Trunk                                │   ✏️ T01  👁 T02 T03 T04       │
│         ├ T05 TAX ...                                             │ computeTotal  (contested)    │
│         └ Workload (300): 241 landed · 12 waiting                 │                              │
├ Drawer (opens on select, 280px, white, slides up 160ms) ──────────┴──────────────────────────────┤
```
- Left-aligned everywhere. There is a single 8px spacing grid.
- 12 agent strips plus 1 workload strip must fit without scrolling at 1440×900.
- **No card kit.** Strips have a 3px radius, a 1px border and no drop shadow. The drawer and rail are flat white planes divided by a 1px border.

### Narrow screens (added 2026-10-10)
The layout above is the "wide" one, from 1280px up. Below that the same things are on screen in a different arrangement (`layoutFor` in `src/ui/lib/view.ts`):

- **Medium, 768 to 1279px.** The top bar is three short rows: what the screen is showing (wordmark, Live pill, Replay/Live); where you are and the player (view tabs, speed, pause, play again, Dispatch); the counters. One lane per row in a plain list: the strip, then its three bays with a short rule between them. Flow is not used here because it spaces nodes 64px apart and clips what does not fit. The ledger is a fourth view tab, not a rail.
- **Phone, under 768px.** The same, with each strip on two lines (callsign and status, then at most two chips, or one chip and its note) and its bays on a line under it. Four counters, not six. The drawer is a sheet that comes up from the bottom, its three columns stacked. Human cards sit at the top of the lanes instead of floating over a corner. The dispatch panel takes the whole width.
- Nothing scrolls sideways at any width from 320px up. The strips, bays, colours, type and vocabulary are the same at every size.

### The tape (added 2026-10-11)
A second way to look at the same Intents, as a tab beside Lanes: time runs left to right, one row for each agent's Intent, trunk along the top. It is the story view: one landing, the rows it stopped, and what became of each. Lanes is still the place for symbols and for what each Intent is doing right now.

- **Marks first, words only where they fit.** Every stretch always draws its mark; its words appear only when the measured stretch is wide enough.
- **Red is the only solid colour:** the flag of a landing that broke a premise, and "needs you". Everything else is an outline: working is filled grey, at the gate is the same outline empty, re-deriving is pale blue with a blue outline, waiting is pale amber with an amber outline. Landed is a green check at the end of the row; the row's history is not recoloured.
- **The break line** is thin and behind the bars across all rows, and heavy with a dot only through the rows it stopped. A stale stretch is drawn from the landing itself (true times are in the tooltip).
- **The axis** shows 1, 1½, 2, 3, 5 or 10 minutes, whichever first keeps "now" inside it, and steps rather than zooms. What has not happened yet is tinted. In a replay the axis is a slider.
- **The label column** is the strip in small: status band, callsign (Barlow Condensed), R stamp, status icon and word.
- **Type:** Geist Sans and Geist Mono, self-hosted (see "The look"). Nothing is under 11px.
- **Phone:** marks only, nothing scrolling sideways; breaks are numbered on the trunk line and listed in words above the rows.

## Motion: one orchestrated moment, everything else responds to the user
- **The moment is the premise break**, the most important event in the product. Keep it to about 1.2 s total:
  1. The red-pen line draws across the "relies on" chip. Animate an SVG `stroke-dashoffset` over 350ms.
  2. The strip's left band turns red, crossfading over 200ms.
  3. The annotation text fades in, 150ms.
  4. The top-bar "Premises broken" counter ticks up.
- **Re-derive stamp:** the stamp appears with a 120ms scale from 1.15 to 1. That is the only other ambient animation.
- **Counters** roll from the old value to the new one over 300ms, using tabular numerals so nothing jitters.
- **Responsive motion:** drawer open/close, Kumo toasts and tooltips.
- **No** entrance animations on load, **no** hover lift on strips, **no** pulsing dots except the 1.5s "Live" pill.
- Under `prefers-reduced-motion: reduce`, every transition is instant and the red line simply appears.

## Delight details (small, functional)
- **Cross-highlight.** Hovering any symbol chip, or a row in the ledger rail, highlights every strip that changes or relies on that symbol and dims the rest to 40%. This is how collisions show, since Flow can't draw edges across lanes.
- **Tooltips on chips** (Kumo `Tooltip`) show:
  - the symbol's one-line declaration (from the surface `decl`);
  - the source: "You read this", "Your code calls this", or "You assert this behaviour";
  - the short surface hash.
- **Keyboard:**

  | Key | Action |
  |---|---|
  | `j` / `k` | Move selection between strips |
  | `Enter` | Open the drawer |
  | `Esc` | Close the drawer |
  | `⌘K` | Command palette (Kumo `Command Palette`): "Dispatch tasks", "Run workload", "Jump to T02", "Reset demo" |
  | `?` | Shortcuts sheet |

- **Live pill states:** "Live", "Reconnecting…" (amber), and "Replay 2×" (blue). It must never be silent about its state.
- **Empty state** (Kumo `Empty`): "No intents in flight. Dispatch tasks to watch agents work." with a **Dispatch tasks** button.
- **Loading:** use Kumo `SkeletonLine`s in strip shape while the event backlog loads, never a spinner in the middle of the board.
- **Human cards** (Kumo `Toast` or `LayerCard`, top-right):
  - One sentence about what happened.
  - One sentence about what each button does.
  - Buttons use the exact action names (Wait / Split / Depend / Retry / Abandon), and the confirmation repeats that name: "Split applied".
- **Relative times:** "12s ago". The exact timestamp shows in a tooltip.
- **Demo markers** ("⏩ 2m 10s compressed") show as a small pill in the top bar for 3 s. They are honest and unobtrusive.

## Copy
- Use plain verbs, sentence case and no filler.
- Name things the way the user sees them:
  - "relies on", not "read-set";
  - "Broken builds on trunk", not "CI failures".
- Errors say what happened and what to do next, e.g. "Couldn't reach the event stream. Retrying in 4s." They never apologise.
- Vocabulary rules from `CLAUDE.md` apply. Never use "merge queue", "PR" or "branch".

## Accessibility floor (non-negotiable)
- AA contrast for all text, including chip text on strip colours.
- A visible focus ring on every interactive element. Use Kumo's ring and never remove outlines.
- All strip buttons are real `<button>`s with an `aria-label`, e.g. "T02 audit expired sessions, stale: premise broke".
- State is never conveyed by colour alone.

## Self-critique (do this before marking any UI task done)
1. **Screenshot it.** Run `npm run dev`, open the app at 1440×900 in light mode, and save a screenshot to `docs/screens/<task>.png`. If you can't take screenshots yourself, ask the user for one.
2. **Look at it as a judge seeing it for 5 seconds.**
   - Can you tell what's broken and why without reading more than one line?
   - Is the premise break the most noticeable thing on screen when it happens?
3. **Check the generic tells and remove any you find:**
   - identical rounded cards with soft shadows;
   - all-caps eyebrow labels;
   - gradient washes;
   - decorative numbering;
   - "→" glued onto buttons;
   - more than one accent colour competing.
4. **Take one thing away.** Remove one decorative element. If nothing feels missing, leave it out.
5. **Write 2–3 lines in `docs/DECISIONS.md`:** what you changed after critique, and anything the next UI task should keep consistent.
