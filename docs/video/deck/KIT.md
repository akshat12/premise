# Premise deck: the kit every slide is built from

One slide is one file, `project/slides/<id>.html`, holding exactly one `<section id="<id>">` and
nothing else. The canvas is fixed at 1920 x 1080 px. Every style is inline. The format is a closed
subset of HTML and CSS: the whole table is in `format.md` (read it once before you write). The
things people get wrong most:

- No `class`, no `<style>`, no `<script>`, no `margin`, no `z-index`, no `em`/`rem`/`vw`/`%` font
  sizes, no `var()`, no CSS `transition`/`animation`/keyframes. Lengths are `px` (or `%` where the
  table allows it).
- Text elements are `<h1> <h2> <h3> <p> <ul>/<ol> of <li>`. Inline only `<b> <i> <u> <span style="color:…">`.
  A `<span>` may set a colour and nothing else. No font-size under 24px anywhere.
- A `<div>` is a container: a flex row (`display:flex`), a column (no `display`, or
  `flex-direction:column`), or a grid. It is invisible unless it has a `background` or `border`.
- `position:absolute` pins an element to the slide (canvas coordinates) or to the nearest
  `position:relative` `<div>`. Give pinned text a `width`.
- Icons are `<x-icon name="…" style="color:#…;width:NNpx;height:NNpx"></x-icon>` and the name must
  be one of exactly these: Activity Book Chart Chat Check CheckCircle Clock Cloud Code Database
  Globe GraduationCap Home Key Lightbulb Lightning Link Lock PaperPlane Play Search Settings Star
  ThumbsUp Tool Trust Users Verified Warning Wrench. There are no others and no emoji.
- Shapes: a painted `<div>` is a rectangle. `<x-shape kind="ellipse|diamond|arrow-right|arrow-left|arrow-up|arrow-down|line" style="background:#…;width;height">`
  (block arrows near 2:1). Lines with arrowheads between things are
  `<x-connector x1 y1 x2 y2 route="straight|hv|vh" head="end|none|both" style="color:#…;border-width:3px"></x-connector>`
  (coordinates are canvas px when it is a child of the section). Shapes, icons and connectors hold no content.
- No `<img>` (the deck has no image files). No arrows or tick characters typed as text: use an icon,
  a shape, or a word.

## The look

Typefaces (the same two as the product's site). Use these two stacks EXACTLY, character for character:

- text: `font-family:'Atkinson Hyperlegible Next', Arial, sans-serif`
- labels, code names, numbers in small caps rows: `font-family:'Atkinson Hyperlegible Mono', 'Courier New', monospace`

Palette (use only these):

| role | hex |
|---|---|
| ink (dark background, darkest text) | `#14181d` |
| paper (light slide background) | `#f3f4f2` |
| card (on paper) | `#fbfbfa` |
| hairline (card border on paper) | `#d5d9d3` |
| soft ink (secondary text on paper) | `#55606b` |
| mid ink (body text in cards) | `#3d4650` |
| grey (neutral strokes, arrows) | `#868e97` |
| neutral bar fill | `#dfe2dd` |
| orange text / eyebrow on paper | `#c2410c` |
| orange stroke / highlight border | `#e8590c` |
| orange on dark | `#f08a4b` |
| green (landed, passed) | `#17654a` |
| landed wash (green lane) | `#d8eedf` |
| stopped wash (red lane) | `#fdeee7` |
| re-derive wash (yellow lane) | `#faefc2` |
| re-derive ink (text on the yellow wash) | `#744a0a` |
| on dark: body `#d8ddd9`, soft `#b6beb8`, softer `#8d9690`, card border `#3a424b`, card fill `#20262d` |

Meaning of colour, the same on every slide: **orange** = what to look at (a premise, a stop, the
point of the slide); **green** = landed / passed; **yellow wash** = being re-derived; grey = neutral.
Colour never says it alone: a status also says so in words ("stopped", "landed").

Type scale (use only these sizes): 68 (the slide's headline), 44 (a card or block title),
34 (a lead or takeaway sentence), 30 (body text in cards), 26 (eyebrow; small mono labels),
24 (footer, chips, the smallest label). Big numbers may be 120.

## The skeleton of a content slide (copy it; change only what is marked)

```html
<section id="ID" data-transition="fade" style="background:#f3f4f2;color:#14181d;font-family:'Atkinson Hyperlegible Next', Arial, sans-serif;padding:128px 128px 160px;display:flex;flex-direction:column;gap:40px">
<div style="display:flex;gap:32px;align-items:center">
<div style="display:flex;align-items:center;justify-content:center;width:112px;height:112px;background:#14181d;border-radius:24px">
<x-icon name="ICON" style="color:#f08a4b;width:60px;height:60px"></x-icon>
</div>
<div style="flex:1;display:flex;flex-direction:column;gap:12px">
<p style="font-family:'Atkinson Hyperlegible Mono', 'Courier New', monospace;font-size:26px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:#c2410c">EYEBROW</p>
<h2 style="font-size:68px;font-weight:600;line-height:1.1;letter-spacing:-1px">HEADLINE</h2>
</div>
</div>
<!-- the picture: pinned elements, see below -->
<div style="position:absolute;left:128px;right:128px;bottom:64px;display:flex;justify-content:space-between">
<p style="font-family:'Atkinson Hyperlegible Mono', 'Courier New', monospace;font-size:24px;letter-spacing:3px;text-transform:uppercase;color:#55606b">Premise</p>
<p style="font-family:'Atkinson Hyperlegible Mono', 'Courier New', monospace;font-size:24px;letter-spacing:1px;color:#55606b">premise.akshatdivekar.workers.dev</p>
</div>
<aside>SPEAKER NOTES</aside>
</section>
```

- The header (icon badge, eyebrow, headline) is the only flow content. It ends at about y = 256.
- The **headline is one line**: at most 40 characters including spaces. It is a short plain
  sentence ending in a full stop, in the same grammar as the others ("The ledger knows who is changing what.").
- The eyebrow is 1 to 4 words.
- The footer row is always exactly as above.
- The speaker notes are what the narrator says over the slide in the video. They are not written
  by hand: `tools/sync_notes.py` copies them from `docs/video/screen-recording-script.md`, with
  that script's bracketed actions ([→] is one press of the right arrow).

## The picture zone

Everything below the header is the picture: **x from 128 to 1792, y from 300 to 900** (1664 x 600).
Nothing pinned may pass y = 900 or x = 1792, or start left of 128 or above 296.

Build the picture from pinned elements that are DIRECT children of the `<section>`, placed in
canvas coordinates with `position:absolute;left:…px;top:…px;width:…px` (and `height` for a painted
box whose height matters). A pinned painted `<div>` may hold flow content (an icon and a few lines
of text in a row or column): that is how a card, a chip or a labelled box is made, and it moves as
one piece.

Geometry you can rely on:
- One line of text is `font-size x line-height` tall (use `line-height:1.3` in the picture: 30px text = 39px a line).
- Width: Atkinson Hyperlegible Next is a wide face. Allow **0.56 x font-size per character**
  (0.60 for bold), and for the Mono **0.62 x font-size per character plus the letter-spacing**.
  A box must be at least as wide as its longest word plus its padding. If a line would wrap when
  you did not mean it to, widen the box or cut words; never shrink the type below the scale.
- Keep 24px or more between separate boxes. Align things on shared lefts and tops.
- A lane (an agent's row on the product's board) is: a mono uppercase label 220px wide ("AGENT 2"),
  then a bar 48px tall with a 1px `#868e97` border. A lane's wash colour is the bar's `background`:
  `#dfe2dd` working, `#d8eedf` landed, `#fdeee7` stopped, `#faefc2` being re-derived.
- A chip (a name from the code, like a function): `<p style="font-family:'Atkinson Hyperlegible Mono', 'Courier New', monospace;font-size:24px;line-height:1.3;color:#14181d;background:#fbfbfa;border:1px solid #d5d9d3;border-radius:8px;padding:6px 14px">verifySession</p>`.
  A chip for something to look at uses `border:2px solid #e8590c`.
- A card: `background:#fbfbfa;border:1px solid #d5d9d3;border-radius:12px;padding:28px 32px`; the
  highlighted one uses `border:2px solid #e8590c` (or `#17654a` for the good outcome).

The picture must be a PICTURE of the idea (things with positions, arrows, bars, a table, tokens),
not three cards of text. Aim for at most about 45 words visible in the picture zone. One idea.

## Motion

Two kinds, both optional per element, both must degrade to a correct still picture.

1. **Builds** (the main one). Put `data-build-in="rise N"` (or `fade N`, `pop N`) on a pinned
   DIRECT child of the section. N is the press it appears on, counting from 1; elements that share
   a number appear together. The first piece of the picture carries no build, so a slide opens
   with something to talk over. In the video the narrator advances beat by beat, so the beats are the
   explanation, in order: 3 to 6 beats a slide. `pop` is for the one moment that matters (a stop,
   a landing, a tick); `rise` or `fade` for the rest. The header and the footer never build.
   With every beat shown at once (the PDF, the editor) the slide must still read correctly, so a
   later beat may cover an earlier one only when the covered thing has become untrue (a grey
   "working" bar covered by a red "stopped" bar of the same size).
2. **A looping animation** (at most one per slide, only where movement IS the idea: something
   travelling from one place to another, a pulse where something breaks).
   The slide viewer shows an inline `<svg>` as a STILL image: SMIL (`<animate>`,
   `<animateTransform>`, `<animateMotion>`, `<set>`) never plays there, and the page's build
   rejects it. So an inline `<svg>` holds only the still drawing (lines, arrowheads, shapes), with
   no animation elements at all, and only the MOVING thing (a travelling dot, a pulse ring) goes
   in ONE live embed:

   `<x-embed style="position:absolute;left:Xpx;top:Ypx;width:Wpx;height:Hpx"><!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden} .dot{…} @keyframes go{…}</style></head><body><div class="dot"></div></body></html></x-embed>`

   - It is a DIRECT child of the `<section>`, pinned with `left`, `top`, `width` and `height` in
     px, under 16 KB, and may carry `data-build-in` like any pinned child. List it after the
     things it moves over.
   - Inside it is a whole small page of its own: ordinary CSS (classes, `@keyframes`,
     `animation: … infinite`) is fine there, and so is an `<svg>` with SMIL. Durations 2s to 5s.
     Coordinates inside it are relative to the embed's own box.
   - No text inside it (the deck's typefaces do not reach it), a transparent background, and only
     palette colours.
   - It is decoration over a picture that is already complete: exports flatten it, so if it did
     not run the slide must lose nothing but the motion. Never put a line, an arrowhead, a box or
     a label in it.
   - `docs/video/deck/project/slides/ledger.html` has a worked one (three dots travelling
     from the ledger to the agents that rely on a function).

## Words

- Use the product's words: **Intent**, **changes**, **relies on**, **premise**, **re-derive**,
  **gate**, **trunk**. The ledger's answers are exactly **Wait**, **Split**, **Depend**.
- Never write "merge queue", "pull request", "PR" or "branch".
- Agents are "Agent 1", "Agent 2"… The running example everywhere: Agent 1 changes the function
  `verifySession` so that an expired session returns null instead of throwing an error; Agent 2
  wrote code that catches that error.
- Plain words for someone who has never seen the product. Say what a thing is before naming it.
- Numbers only from the fact sheet you are given. Never invent one.

## Tools (run them; fix what they say; look at your own slide)

- Check the format: `python3 -I docs/video/deck/tools/lint_slide.py <your slide file>` : fix every ERROR, and
  every WARN unless you can say why it is wrong.
- Look at it: `docs/video/deck/tools/shot.sh <your root folder> <slide id> <out.png>` renders your slide to a
  PNG (and prints a JSON list of anything that overflows); add a fourth argument `builds` to see
  the beat numbers. Then open the PNG with your Read tool and LOOK: is anything cut off, touching,
  overlapping, off the grid, or too small? Is it a picture or a wall of text? Fix and render
  again. Do this at least twice. The preview's icons are stand-ins for the real ones (same size
  and place, slightly different drawing), and it shows all beats at once.

## A finished example

`docs/video/deck/project/slides/ledger.html` is a finished slide in this kit. Read it for the
markup of the header, a pinned row, chips, builds and a live embed. A new slide shows a different
idea and needs its own picture.
