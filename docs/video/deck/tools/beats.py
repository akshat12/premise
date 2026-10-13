#!/usr/bin/env python3
"""Prints, for each slide file given, its headline, what appears on each build beat, and its notes.
    python3 -I beats.py <slide.html> ...
"""
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class Beats(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.beats, self.h2, self.aside, self.skip = [], {}, "", "", 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        beat = None
        if "data-build-in" in a:
            m = re.search(r"\d+", a["data-build-in"])
            beat = int(m.group(0)) if m else 0
        if tag in ("svg", "x-embed"):
            self.skip += 1
            if beat is not None:
                self.beats.setdefault(beat, []).append(f"<{tag}>" if tag == "svg" else "<moving part>")
        if tag in ("br", "hr", "img"):
            return
        self.stack.append((tag, beat))

    def handle_endtag(self, tag):
        if tag in ("svg", "x-embed"):
            self.skip = max(0, self.skip - 1)
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        text = " ".join(data.split())
        if not text or self.skip:
            return
        tags = [t for t, _ in self.stack]
        if "aside" in tags:
            self.aside += text + " "
            return
        if "h2" in tags or "h1" in tags:
            self.h2 += text + " "
            return
        beat = next((b for _, b in reversed(self.stack) if b is not None), None)
        self.beats.setdefault(beat if beat is not None else 0, []).append(text)


for path in sys.argv[1:]:
    reader = Beats()
    reader.feed(Path(path).read_text())
    print(f"=== {Path(path).stem}: {reader.h2.strip()}")
    for beat in sorted(reader.beats):
        words = " | ".join(reader.beats[beat])
        print(f"  [{'always' if beat == 0 else beat}] {words[:330]}")
    print(f"  NOTES ({len(reader.aside.split())} words): {reader.aside.strip()[:700]}")
