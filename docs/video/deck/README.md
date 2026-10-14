# The video deck

The slides used in the screen recording, with the tools that check them. The published deck is a claude.ai Artifact made from these files; this folder is its source.

- `project/deck.json` is the index: the order of the slides, the four sections, and the two typefaces (Atkinson Hyperlegible Next and Mono, the same as the site).
- `project/slides/<id>.html` is one slide each: one `<section>` on a fixed 1920×1080 canvas, every style inline, in the Slides format's closed subset of HTML and CSS.
- `KIT.md` is the design guide every slide follows: the skeleton, the palette, the type scale, how pictures are built from pinned pieces, and how motion works.
- The read-aloud script for the video is kept outside the repo (in a git-ignored `private/` folder). Each slide's speaker notes are copied from it.

## How a slide is put together

- The header (icon, eyebrow, one-line headline) is ordinary flow content. Everything in the picture is pinned to the slide in canvas pixels.
- A picture builds in steps. A piece with `data-build-in="rise 2"` appears on the second press of the right arrow. The first piece carries no build, so a slide opens with something to talk over.
- Looping motion (a travelling dot, a pulse) lives in one small live embed, `<x-embed>`. The slide viewer shows an inline `<svg>` as a still image, so nothing inside one is animated.

## Tools

Run them from the repo root. They need Python 3; `shot.sh` also needs Google Chrome.

| Command | What it does |
|---|---|
| `python3 docs/video/deck/tools/lint_slide.py docs/video/deck/project/slides/*.html` | Checks every slide against the format's subset and the kit: tags, CSS, type sizes, icon names, the two typefaces, the palette, the project's forbidden words |
| `docs/video/deck/tools/shot.sh docs/video/deck <slide id> out.png` | Renders one slide to a PNG with headless Chrome and prints anything that overflows. Add `builds` as a fourth argument to number the pieces by the press they appear on |
| `python3 docs/video/deck/tools/preview.py docs/video/deck out.html` | Writes one page with every slide on it (`out.html?s=<id>` for one at full size) |
| `python3 docs/video/deck/tools/beats.py docs/video/deck/project/slides/<id>.html` | Lists what appears on each press of a slide |
| `python3 docs/video/deck/tools/check_script.py private/screen-recording-script.md docs/video/deck` | Counts the script's spoken words and checks that each slide's `[→]` presses equal its build steps |
| `python3 docs/video/deck/tools/sync_notes.py private/screen-recording-script.md docs/video/deck --write` | Copies the script's lines into each slide's speaker notes |

The preview is an approximation of the real viewer, good for layout: its icons are stand-ins from another icon set (same size and place), and it shows every build step at once.
