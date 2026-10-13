#!/usr/bin/env python3
"""Checks the read-aloud script against the slide files: spoken word count, and that each slide's
number of [→] presses is its number of build beats.

    python3 check_script.py <script.md> <deck root>      (the root holds project/deck.json)
"""
import json
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
body = text.split("\n---\n", 1)[1]
root = Path(sys.argv[2])
ORDER = json.loads((root / "project/deck.json").read_text())["order"]

def slide_file(sid):
    for candidate in (root / "project/slides" / f"{sid}.html",):
        if candidate.exists():
            return candidate
    return None

spoken_total = 0
sections = re.split(r"\n(?=### Slide \d+)", body)
by_slide = {}
loose = []
for block in sections:
    m = re.match(r"### Slide (\d+)", block)
    lines = block.split("\n")
    spoken, presses = [], 0
    for line in lines:
        if line.startswith("#") or not line.strip():
            continue
        presses += len(re.findall(r"\*\*\[→\]\*\*", line))
        said = re.sub(r"\*\*\[[^\]]*\]\*\*", " ", line)
        said = re.sub(r"[*_`]", "", said).strip()
        if said:
            spoken.append(said)
    words = sum(len(s.split()) for s in spoken)
    spoken_total += words
    if m:
        by_slide[int(m.group(1))] = (words, presses)
    else:
        loose.append(words)
print(f"spoken words: {spoken_total}  (at 150 a minute: {spoken_total / 150:.1f} min; at 140: {spoken_total / 140:.1f} min)")
bad = 0
for number, sid in enumerate(ORDER, 1):
    path = slide_file(sid)
    beats = set()
    if path:
        beats = {int(x) for x in re.findall(r'data-build-in="[a-z]+ (\d+)', path.read_text())}
    words, presses = by_slide.get(number, (0, 0))
    ok = presses == len(beats)
    bad += not ok
    print(f"  slide {number:2} {sid:9} words {words:4}  presses {presses}  beats on the slide {sorted(beats)}  {'ok' if ok else 'MISMATCH'}")
print("mismatches:", bad)
