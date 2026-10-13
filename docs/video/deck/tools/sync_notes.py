#!/usr/bin/env python3
"""Writes each slide's speaker notes (<aside>) from the read-aloud script, so the deck's presenter
view says exactly what the script says, with the same bracketed actions.
    python3 sync_notes.py <script.md> <deck root> [--write]      (the root holds project/deck.json)
"""
import html
import json
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text().split("\n---\n", 1)[1]
root = Path(sys.argv[2])
slides = root / "project/slides"
ORDER = json.loads((root / "project/deck.json").read_text())["order"]
write = "--write" in sys.argv
blocks = re.split(r"\n(?=### Slide \d+)", text)
for block in blocks:
    m = re.match(r"### Slide (\d+)", block)
    if not m:
        continue
    sid = ORDER[int(m.group(1)) - 1]
    parts = []
    for line in block.split("\n")[1:]:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"\*\*(\[[^\]]*\])\*\*", r"\1", line)
        line = re.sub(r"[*_`]", "", line)
        parts.append(line)
    notes = " ".join(parts)
    notes = re.sub(r"\s+", " ", notes).strip()
    assert len(notes) <= 4000, (sid, len(notes))
    path = slides / f"{sid}.html"
    source = path.read_text()
    assert source.count("<aside>") == 1 and source.count("</aside>") == 1, sid
    updated = re.sub(r"<aside>.*?</aside>", lambda _: f"<aside>{html.escape(notes, quote=False)}</aside>", source, flags=re.S)
    if write:
        path.write_text(updated)
    else:
        print(f"[{sid}] {len(notes)} chars: {notes[:160]}…")
print("written" if write else "dry run")
