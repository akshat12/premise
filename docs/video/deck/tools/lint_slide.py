#!/usr/bin/env python3
"""Checks one or more slide files (project/slides/<id>.html) against the Slides format's closed subset
and this deck's own style rules. Prints one line per problem; exits 1 if any ERROR was found.

    python3 -I lint_slide.py <slide.html> [<slide.html> ...]

ERROR  = the page would drop or mangle it, or it breaks a deck rule. Must be fixed.
WARN   = probably wrong (overflow estimate, off-palette colour). Look at it.
"""
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ICONS = set("Activity Book Chart Chat Check CheckCircle Clock Cloud Code Database Globe GraduationCap Home Key Lightbulb Lightning Link Lock PaperPlane Play Search Settings Star ThumbsUp Tool Trust Users Verified Warning Wrench".split())
SHAPES = {"rect", "rounded", "ellipse", "diamond", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "line"}
TAGS = {"section", "h1", "h2", "h3", "p", "ul", "ol", "li", "br", "b", "i", "u", "a", "span", "div", "img", "table", "tr", "th", "td", "svg", "hr", "x-shape", "x-icon", "x-connector", "x-embed", "aside"}
VOID = {"br", "hr", "img"}
TEXT = {"h1", "h2", "h3", "p", "ul", "ol"}
PROPS = set("""position left top right bottom width height min-width min-height max-width max-height display flex-direction flex-wrap gap
align-items justify-content justify-items align-self justify-self flex flex-grow flex-shrink flex-basis grid-template-columns
grid-template-rows grid-column grid-row aspect-ratio padding overflow font-family font-size font-weight font-style font line-height
letter-spacing text-align text-transform white-space text-decoration font-variant-numeric -webkit-text-stroke color background
background-clip -webkit-text-fill-color border border-top border-right border-bottom border-left border-radius box-shadow text-shadow
opacity transform filter backdrop-filter mix-blend-mode object-fit border-width border-style""".split())
BUILD = re.compile(r"^(fade|rise|drop|left|right|scale|pop)( ([1-9]|[1-4][0-9]|50))?( auto)?$")
PALETTE = {c.lower() for c in """#14181d #f3f4f2 #fbfbfa #d5d9d3 #55606b #3d4650 #868e97 #c2410c #e8590c #f08a4b #17654a #d8eedf #fdeee7 #faefc2
#744a0a #b6beb8 #8d9690 #d8ddd9 #3a424b #dfe2dd #1d6f8a #e3eef2 #20262d #2a323b""".split()}
FORBIDDEN = [r"merge queue", r"pull request", r"\bPRs?\b", r"\bbranch(es)?\b"]
FAMILIES = ("'Atkinson Hyperlegible Next', Arial, sans-serif", "'Atkinson Hyperlegible Mono', 'Courier New', monospace")


def px(value):
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)(px)?", value.strip())
    return float(m.group(1)) if m else None


def styles(text):
    out = {}
    for part in (text or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


class Node:
    def __init__(self, tag, attrs, parent, line):
        self.tag, self.attrs, self.parent, self.line = tag, dict(attrs), parent, line
        self.children, self.text = [], ""
        self.style = styles(self.attrs.get("style"))

    def pinned(self):
        return self.style.get("position") == "absolute" or (self.tag == "x-connector" and "x1" in self.attrs)


class Reader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", [], None, 0)
        self.at = self.root
        self.svg_depth = 0
        self.embed_depth = 0
        self.problems = []

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        if self.svg_depth or self.embed_depth:
            if tag == "svg":
                self.svg_depth += 1
            if self.svg_depth and tag in ("animate", "animatetransform", "animatemotion", "set", "animatecolor"):
                self.problems.append(("ERROR", line, f"<{tag}> inside an inline <svg>: the slide viewer shows an inline svg as a still image, SMIL does not play, and the page's build rejects it. Keep the still drawing inline with no animation, and put only the moving part in a pinned <x-embed>"))
            if self.svg_depth and tag in ("script", "foreignobject", "text"):
                self.problems.append(("ERROR" if tag != "text" else "WARN", line, f"<{tag}> inside <svg> (no script or foreignObject; fonts do not load for <text>, use a <p> over the drawing)"))
            if self.svg_depth:
                for key, _ in attrs:
                    if key.lower().startswith("on"):
                        self.problems.append(("ERROR", line, f"{key}= inside <svg>"))
            return
        node = Node(tag, attrs, self.at, line)
        self.at.children.append(node)
        if tag == "svg":
            self.svg_depth = 1
            self.at = node
        elif tag == "x-embed":
            self.embed_depth = 1
            self.at = node
        elif tag not in VOID:
            self.at = node

    def handle_startendtag(self, tag, attrs):
        if self.svg_depth and tag in ("animate", "animatetransform", "animatemotion", "set", "animatecolor"):
            self.problems.append(("ERROR", self.getpos()[0], f"<{tag}> inside an inline <svg>: the slide viewer shows an inline svg as a still image, SMIL does not play, and the page's build rejects it. Keep the still drawing inline with no animation, and put only the moving part in a pinned <x-embed>"))
        if self.svg_depth or self.embed_depth:
            return
        self.at.children.append(Node(tag, attrs, self.at, self.getpos()[0]))

    def handle_endtag(self, tag):
        if self.svg_depth:
            if tag == "svg":
                self.svg_depth -= 1
                if self.svg_depth == 0:
                    self.at = self.at.parent
            return
        if self.embed_depth:
            if tag == "x-embed":
                self.embed_depth = 0
                self.at = self.at.parent
            return
        if tag in VOID:
            return
        node = self.at
        while node is not None and node.tag != tag:
            node = node.parent
        if node is None:
            self.problems.append(("ERROR", self.getpos()[0], f"</{tag}> closes nothing"))
            return
        if node is not self.at:
            self.problems.append(("ERROR", self.getpos()[0], f"</{tag}> closes while <{self.at.tag}> (line {self.at.line}) is still open"))
        self.at = node.parent

    def handle_data(self, data):
        if not (self.svg_depth or self.embed_depth):
            self.at.text += data


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def all_text(node):
    return node.text + "".join(all_text(child) for child in node.children)


def inherited(node, prop):
    while node is not None:
        if prop in node.style:
            return node.style[prop]
        node = node.parent
    return None


def lint(path):
    source = Path(path).read_text()
    problems = []
    add = lambda level, line, message: problems.append((level, line, message))
    reader = Reader()
    reader.feed(source)
    reader.close()
    problems += reader.problems
    if reader.at is not reader.root:
        add("ERROR", reader.at.line, f"<{reader.at.tag}> is never closed")
    tops = reader.root.children
    if len(tops) != 1 or tops[0].tag != "section":
        add("ERROR", 1, "the file must hold exactly one <section> and nothing else")
        return problems
    if reader.root.text.strip():
        add("ERROR", 1, "text outside the <section>")
    section = tops[0]
    want = Path(path).stem
    if section.attrs.get("id") != want:
        add("ERROR", section.line, f'section id is "{section.attrs.get("id")}", the file name says "{want}"')
    if "background" not in section.style:
        add("ERROR", section.line, "the section needs a background")
    if section.attrs.get("data-transition") not in (None, "fade", "push", "magic"):
        add("ERROR", section.line, "data-transition must be fade, push or magic")
    asides = [child for child in section.children if child.tag == "aside"]
    if len(asides) > 1 or (asides and section.children[-1].tag != "aside"):
        add("ERROR", section.line, "one <aside>, and it must be the section's last child")
    if not asides:
        add("WARN", section.line, "no speaker notes (<aside>)")
    elif len(all_text(asides[0])) > 4000:
        add("ERROR", asides[0].line, "speaker notes are over 4,000 characters")
    for node in walk(section):
        if node.tag == "aside" and node.parent is not section:
            add("ERROR", node.line, "<aside> must be a direct child of the section")

    nodes = [node for node in walk(section)]
    if len(nodes) > 200:
        add("ERROR", section.line, f"{len(nodes)} elements on the slide (200 at most)")
    embeds = 0
    for node in nodes:
        tag, style, line = node.tag, node.style, node.line
        if tag not in TAGS:
            add("ERROR", line, f"<{tag}> is not in the slide format")
            continue
        if "class" in node.attrs:
            add("ERROR", line, "class= is ignored: every style is inline")
        for key in node.attrs:
            if key.startswith("on"):
                add("ERROR", line, f"{key}= is not allowed")
        # nesting depth of divs
        depth, up = 0, node
        while up is not None:
            depth += up.tag == "div"
            up = up.parent
        if depth > 15:
            add("ERROR", line, "more than 15 nested <div>s")
        for prop, value in style.items():
            if prop not in PROPS:
                add("ERROR", line, f"`{prop}` is not in the supported CSS (no margin, z-index, float, transition, animation…)")
                continue
            if re.search(r"\d(em|rem|vw|vh|pt)\b", value) and prop != "letter-spacing":
                add("ERROR", line, f"`{prop}:{value}` uses a unit the format does not take (px or % only)")
            if "var(" in value or "currentcolor" in value.lower():
                add("ERROR", line, f"`{prop}:{value}`: no var() or currentcolor")
            if "calc(" in value and prop not in ("left", "top"):
                add("ERROR", line, f"`{prop}:{value}`: calc() only on left/top")
            if prop in ("color", "background", "border", "border-top", "border-bottom", "border-left", "border-right"):
                for colour in re.findall(r"#[0-9a-fA-F]{3,8}\b", value):
                    if colour.lower() not in PALETTE:
                        add("WARN", line, f"{colour} is not in the deck's palette")
        if tag == "span" and set(style) - {"color", "-webkit-text-fill-color", "font-weight", "font-style", "text-decoration"}:
            add("ERROR", line, "a <span> may only set color (no sizes or fonts on spans)")
        if tag in ("b", "i", "u") and style:
            add("ERROR", line, f"<{tag}> takes no style")
        if tag in TEXT or tag in ("li", "td", "th"):
            size = style.get("font-size") or inherited(node.parent, "font-size")
            if tag in ("h1", "h2", "h3") and "font-size" not in style:
                add("ERROR", line, f"<{tag}> must set its own font-size (it does not inherit one)")
            value = px(size) if size else None
            if value is not None and value < 24:
                add("ERROR", line, f"font-size {size} is under 24px")
            if tag in TEXT and "font-size" not in style and tag not in ("ul", "ol") and inherited(node.parent, "font-size") is None:
                add("WARN", line, f"<{tag}> has no font-size (it would default)")
        if "font-family" in style and style["font-family"] not in FAMILIES:
            add("ERROR", line, f"font-family must be exactly one of the deck's two stacks, not `{style['font-family']}`")
        if tag == "x-icon":
            if node.attrs.get("name") not in ICONS:
                add("ERROR", line, f'x-icon name "{node.attrs.get("name")}" is not one of the format\'s icons')
            if node.children or node.text.strip():
                add("ERROR", line, "x-icon holds no content")
            width = px(style.get("width", ""))
            if width is None or px(style.get("height", "")) is None:
                add("ERROR", line, "x-icon needs width and height in px")
            elif width < 28:
                add("WARN", line, "an icon under 28px reads as a speck")
        if tag == "x-shape":
            if node.attrs.get("kind") not in SHAPES:
                add("ERROR", line, f'x-shape kind "{node.attrs.get("kind")}" is not supported')
            if node.children or node.text.strip():
                add("ERROR", line, "x-shape holds no content")
            if node.attrs.get("kind", "").startswith("arrow"):
                w, h = px(style.get("width", "")), px(style.get("height", ""))
                if w and h and max(w, h) / min(w, h) > 3:
                    add("WARN", line, "a block arrow past 3:1 looks stretched; use an x-connector for a long arrow")
        if tag == "x-connector":
            coords = [key for key in ("x1", "y1", "x2", "y2") if key in node.attrs]
            if coords and len(coords) != 4:
                add("ERROR", line, "x-connector needs all of x1 y1 x2 y2, or none")
            if coords and any(key in style for key in ("left", "top", "width", "height")):
                add("ERROR", line, "an x-connector with coordinates takes no left/top/width/height")
            if node.attrs.get("route") not in (None, "straight", "hv", "vh", "elbow"):
                add("ERROR", line, "x-connector route must be straight, hv, vh or elbow")
            if node.attrs.get("head") not in (None, "end", "both", "none"):
                add("ERROR", line, "x-connector head must be end, both or none")
            if node.children or node.text.strip():
                add("ERROR", line, "x-connector holds no content")
        if tag == "x-embed":
            embeds += 1
            if node.parent is not section:
                add("ERROR", line, "x-embed must be a direct child of the section")
            if style.get("position") != "absolute" or any(px(style.get(key, "")) is None for key in ("left", "top", "width", "height")):
                add("ERROR", line, "x-embed must be pinned with position:absolute and left, top, width and height in px")
        if tag == "img":
            add("ERROR", line, "no <img> in this deck (there are no uploaded images); draw with shapes, icons or an <svg>")
        if tag == "svg":
            if "viewbox" not in {key.lower() for key in node.attrs}:
                add("ERROR", line, "<svg> needs a viewBox")
            if not node.attrs.get("aria-label"):
                add("WARN", line, "<svg> has no aria-label (its alt text)")
        if tag == "div" and style.get("position") == "relative":
            pinned = [child for child in node.children if child.pinned()]
            if len(pinned) > 24:
                add("ERROR", line, f"{len(pinned)} pinned children in one host <div> (24 at most)")
            flow = [child for child in node.children if not child.pinned()]
            if not flow and (px(style.get("width", "")) is None or px(style.get("height", "")) is None):
                add("ERROR", line, "a host <div> with no flow child needs width and height")
        for attr in ("data-build-in", "data-build-out"):
            if attr in node.attrs:
                if node.parent is not section or not node.pinned():
                    add("ERROR", line, f"{attr} only works on the section's own position:absolute children")
                if not BUILD.match(node.attrs[attr].strip()):
                    add("ERROR", line, f'{attr}="{node.attrs[attr]}" should be like "rise 2" (fade|rise|drop|left|right|scale|pop, then an order 1-50, then optionally auto)')
        # pinned bounds on the canvas
        if node.parent is section and style.get("position") == "absolute":
            left, top, width, height = (px(style.get(key, "")) for key in ("left", "top", "width", "height"))
            if left is not None and width is not None and left + width > 1920:
                add("ERROR", line, f"pinned box runs off the canvas on the right (left {left:.0f} + width {width:.0f} > 1920)")
            elif left is not None and width is not None and (left < 128 or left + width > 1792) and not (left == 0 and width == 1920):
                add("WARN", line, f"pinned box is outside the 128px side margins (x {left:.0f} to {left + width:.0f})")
            if top is not None and height is not None and top + height > 1080:
                add("ERROR", line, f"pinned box runs off the canvas at the bottom (top {top:.0f} + height {height:.0f} > 1080)")
            elif top is not None and height is not None and top + height > 920 and "bottom" not in style and not (top == 0 and height == 1080):
                add("WARN", line, f"pinned box passes y 920, where the footer band starts (ends at {top + height:.0f})")
            if tag in TEXT and width is None and not ("left" in style and "right" in style):
                add("WARN", line, "pinned text needs a width so that it wraps")
        # longest word against a fixed width
        if tag in ("p", "h1", "h2", "h3") and px(style.get("width", "")) is not None:
            size = px(style.get("font-size", "") or (inherited(node.parent, "font-size") or ""))
            words = re.findall(r"\S+", all_text(node))
            if size and words:
                caps = style.get("text-transform") == "uppercase"
                spacing = px(style.get("letter-spacing", "0")) or 0
                mono = "Mono" in (style.get("font-family") or "")
                per = size * (0.62 if mono else 0.56) * (1.08 if caps else 1) + spacing
                longest = max(words, key=len)
                pad = 0
                if len(longest) * per + pad > px(style["width"]) + 2:
                    add("WARN", line, f'"{longest}" (about {len(longest) * per:.0f}px) is wider than its {style["width"]} box')
    if embeds > 8:
        add("ERROR", section.line, "more than 8 x-embeds on one slide")
    for match in re.finditer(r"<svg\b.*?</svg>", source, re.S):
        if len(match.group(0).encode()) > 52_000:
            add("ERROR", source[: match.start()].count("\n") + 1, "an <svg> is over 52 KB")
    for match in re.finditer(r"<x-embed\b.*?</x-embed>", source, re.S):
        if len(match.group(0).encode()) > 16_000:
            add("ERROR", source[: match.start()].count("\n") + 1, "an <x-embed> is over 16 KB")
    if re.search(r"<style\b", re.sub(r"<svg\b.*?</svg>|<x-embed\b.*?</x-embed>", "", source, flags=re.S)):
        add("ERROR", 1, "<style> is not allowed in a slide file")
    if re.search(r"<script\b", re.sub(r"<x-embed\b.*?</x-embed>", "", source, flags=re.S)):
        add("ERROR", 1, "<script> is not allowed outside an x-embed")
    words = all_text(section)
    for pattern in FORBIDDEN:
        for match in re.finditer(pattern, words):
            add("ERROR", section.line, f'the deck never says "{match.group(0)}" (project vocabulary rule)')
    if re.search(r"[←-⇿✓✗★☐]", re.sub(r"<svg\b.*?</svg>|<aside>.*?</aside>|<x-embed\b.*?</x-embed>", "", source, flags=re.S)):
        add("WARN", 1, "an arrow or dingbat character: these fall back to a system font; use x-icon, x-shape or a word")
    return problems


def main():
    failed = False
    for path in sys.argv[1:]:
        problems = sorted(lint(path), key=lambda item: (item[0] != "ERROR", item[1]))
        for level, line, message in problems:
            print(f"{Path(path).name}:{line}: {level}: {message}")
            failed = failed or level == "ERROR"
        if not problems:
            print(f"{Path(path).name}: ok")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
