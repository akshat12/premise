#!/usr/bin/env python3
"""Builds the deck as one self-contained page the Premise site serves at /slides/: every slide,
its builds stepped through one press at a time, and under each step the words the read-aloud
script says there (taken from the slide's <aside>), so the deck reads without a narrator.

    python3 -I build_player.py <root> <out.html>

<root> holds project/deck.json and project/slides/<id>.html. Like preview.py, this is our own
renderer of the slide format, not the Slides page: icons are stand-ins from another icon set.
Run it again after any slide changes (npm run slides).
"""
import html
import json
import re
import sys
from pathlib import Path

root, out = Path(sys.argv[1]), Path(sys.argv[2])
deck = json.loads((root / "project/deck.json").read_text())
icons = json.loads((Path(__file__).parent / "icons.json").read_text())
order = [slide for slide in deck["order"] if (root / f"project/slides/{slide}.html").exists()]
sources = [(root / f"project/slides/{slide}.html").read_text() for slide in order]
links = "\n".join(f'<link rel="stylesheet" href="{face["href"]}">' for face in deck.get("faces", {}).values() if "href" in face)


def captions(source: str) -> list[str]:
    """One caption for each step of a slide: the notes, cut at each [→], with the actions for the person recording taken out."""
    found = re.search(r"<aside>(.*?)</aside>", source, flags=re.S)
    notes = html.unescape(found.group(1)) if found else ""
    # What is said while the browser is on screen describes the site, not this slide.
    notes = re.sub(r"\[SWITCH TO THE BROWSER.*?\[BACK TO THE SLIDES[^\]]*\]", "", notes, flags=re.S)
    parts = [re.sub(r"\[[^\]]*\]", "", part) for part in notes.split("[→]")]
    return [" ".join(part.split()) for part in parts]


def steps(source: str) -> int:
    return max([int(n) for n in re.findall(r'data-build-in="[a-z]+ (\d+)"', source)] or [0])


told = []
for slide, source in zip(order, sources):
    lines = captions(source)
    if len(lines) != steps(source) + 1:
        print(f"{slide}: {len(lines)} captions for {steps(source) + 1} steps; the whole of its notes is shown on every step")
        lines = [" ".join(lines)]
    told.append(lines)

page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>How Premise works</title>
__LINKS__
<style>
html, body { margin: 0; height: 100%; background: #14181d; color: #f3f4f2; font-family: 'Atkinson Hyperlegible Next', Arial, sans-serif; overflow: hidden; }
/* The stage is 1920 wide before it is scaled: clipped here, or a phone zooms the whole page out to fit it. */
#room { position: absolute; left: 0; right: 0; top: 0; overflow: hidden; cursor: pointer; }
#stage { position: absolute; width: 1920px; height: 1080px; transform-origin: 0 0; background: #f3f4f2; overflow: hidden; }
section { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; }
section, section * { box-sizing: border-box; }
section h1, section h2, section h3, section p, section ul, section ol { margin: 0; }
section h1 { font-size: 96px; font-weight: 600; line-height: 1.1; }
section h2 { font-size: 64px; font-weight: 600; line-height: 1.15; }
section h3 { font-size: 44px; font-weight: 600; line-height: 1.2; }
section p, section li { font-size: 32px; font-weight: 400; line-height: 1.4; }
section div { min-width: 0; }
section div:not([style*="display:"]) { display: flex; flex-direction: column; }
section:not([style*="display:"]) { display: flex; flex-direction: column; }
section.off { display: none !important; }
section aside { display: none; }
section x-icon { display: block; flex: none; }
section x-icon svg { display: block; width: 100%; height: 100%; }
section x-shape { display: block; flex: none; }
section x-connector { display: block; flex: none; }
section svg { display: block; flex: none; }
/* A piece that builds in: hidden until its step, then it fades, rises or pops into place. */
[data-build-in] { transition: opacity 320ms ease-out, translate 320ms ease-out, scale 320ms ease-out; }
[data-build-in].later { opacity: 0; visibility: hidden; transition: none; }
[data-build-in^="rise"].later { translate: 0 28px; }
[data-build-in^="pop"].later { scale: 0.88; }
@media (prefers-reduced-motion: reduce) { [data-build-in] { transition: none; } }
#bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 16px; padding: 10px 16px; box-sizing: border-box; background: #14181d; border-top: 1px solid #2c333b; }
#said { flex: 1; min-width: 0; margin: 0; font-size: 17px; line-height: 1.4; color: #e6e8e4; }
#count { flex: none; display: flex; align-items: center; gap: 6px; font-family: 'Atkinson Hyperlegible Mono', 'Courier New', monospace; font-size: 13px; letter-spacing: 1px; color: #b6beb8; white-space: nowrap; }
/* The slide number can be typed over: Enter goes to that slide. */
#jump { width: 3.2em; box-sizing: border-box; padding: 4px 6px; font: inherit; color: #f3f4f2; text-align: right; background: #232a31; border: 1px solid #3a424b; border-radius: 6px; }
#jump:hover { border-color: #8d9690; }
#jump:focus { outline: 2px solid #f08a4b; outline-offset: 1px; border-color: #f08a4b; }
#bar button, #bar a { flex: none; font: inherit; font-size: 15px; color: #f3f4f2; background: #232a31; border: 1px solid #3a424b; border-radius: 6px; padding: 8px 14px; cursor: pointer; text-decoration: none; white-space: nowrap; }
#bar button:hover:not(:disabled), #bar a:hover { border-color: #f08a4b; }
#bar button:disabled { opacity: 0.4; cursor: default; }
#bar button:focus-visible, #bar a:focus-visible { outline: 2px solid #f08a4b; outline-offset: 2px; }
#next { background: #e8590c !important; border-color: #e8590c !important; color: #fff !important; }
/* A phone held upright gets a small slide: say how to get a bigger one. */
#turn { display: none; }
@media (orientation: portrait) and (max-width: 720px) {
	#turn { display: block; position: absolute; top: 16px; left: 16px; right: 16px; margin: 0; text-align: center; font-size: 14px; color: #8d9690; }
}
@media (max-width: 720px) {
	#bar { flex-wrap: wrap; gap: 8px; padding: 8px 12px; }
	#said { flex-basis: 100%; font-size: 15px; }
	#count { flex: 1; }
}
</style></head><body>
<div id="room"><p id="turn">Turn your phone sideways for a bigger slide.</p><div id="stage">
__SLIDES__
</div></div>
<div id="bar">
<p id="said" aria-live="polite"></p>
<label id="count" title="Type a slide number and press Enter"><span class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Slide</span><input id="jump" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" aria-label="Slide number. Type one and press Enter to go there."><span id="total"></span></label>
<button id="back" type="button" aria-label="Back one step">Back</button>
<button id="next" type="button" aria-label="Next step">Next</button>
<a id="leave" href="/">Open the demo</a>
</div>
<script>
const ICONS = __ICONS__;
const SAID = __SAID__;
const px = (value) => (value == null || value === "" ? null : parseFloat(value));
const sections = [...document.querySelectorAll("#stage > section")];

for (const icon of document.querySelectorAll("x-icon")) icon.innerHTML = ICONS[icon.getAttribute("name")] ?? "";
for (const shape of document.querySelectorAll("x-shape")) {
	const kind = shape.getAttribute("kind");
	const clips = {
		"arrow-right": "polygon(0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%)",
		"arrow-left": "polygon(100% 25%, 40% 25%, 40% 0, 0 50%, 40% 100%, 40% 75%, 100% 75%)",
		"arrow-down": "polygon(25% 0, 75% 0, 75% 60%, 100% 60%, 50% 100%, 0 60%, 25% 60%)",
		"arrow-up": "polygon(25% 100%, 75% 100%, 75% 40%, 100% 40%, 50% 0, 0 40%, 25% 40%)",
		diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
	};
	if (clips[kind]) shape.style.clipPath = clips[kind];
	if (kind === "ellipse") shape.style.borderRadius = "50%";
	if (kind === "rounded") shape.style.borderRadius = shape.style.borderRadius || "16px";
	if (kind === "line") shape.style.height = shape.style.height || "2px";
}
const NS = "http://www.w3.org/2000/svg";
for (const connector of [...document.querySelectorAll("x-connector")]) {
	const color = connector.style.color || "#14181d";
	const width = px(connector.style.borderWidth) ?? 2;
	const dashed = connector.style.borderStyle === "dashed" ? `${width * 3} ${width * 3}` : connector.style.borderStyle === "dotted" ? `${width} ${width * 2}` : "";
	const head = connector.getAttribute("head") ?? "end";
	const draw = (host, x1, y1, x2, y2, route, w, h, inPlace) => {
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("width", w); svg.setAttribute("height", h);
		svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none";
		let d = `M ${x1} ${y1} `;
		let last = [x1, y1];
		if (route === "hv") { d += `L ${x2} ${y1} `; last = [x2, y1]; }
		else if (route === "vh") { d += `L ${x1} ${y2} `; last = [x1, y2]; }
		else if (route === "elbow") { const mid = (x1 + x2) / 2; d += `L ${mid} ${y1} L ${mid} ${y2} `; last = [mid, y2]; }
		d += `L ${x2} ${y2}`;
		const path = document.createElementNS(NS, "path");
		path.setAttribute("d", d); path.setAttribute("fill", "none"); path.setAttribute("stroke", color); path.setAttribute("stroke-width", width);
		path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
		if (dashed) path.setAttribute("stroke-dasharray", dashed);
		svg.append(path);
		const arrow = (tipX, tipY, fromX, fromY) => {
			const angle = Math.atan2(tipY - fromY, tipX - fromX), size = width * 4;
			const point = (a, r) => `${tipX + Math.cos(angle + a) * r},${tipY + Math.sin(angle + a) * r}`;
			const tri = document.createElementNS(NS, "polygon");
			tri.setAttribute("points", `${tipX},${tipY} ${point(Math.PI - 0.45, size)} ${point(Math.PI + 0.45, size)}`);
			tri.setAttribute("fill", color);
			svg.append(tri);
		};
		if (head === "end" || head === "both") arrow(x2, y2, last[0], last[1]);
		if (head === "both") arrow(x1, y1, route === "vh" ? x1 : x2, route === "vh" ? y2 : y1);
		if (connector.hasAttribute("data-build-in")) svg.setAttribute("data-build-in", connector.getAttribute("data-build-in"));
		if (inPlace) connector.replaceWith(svg); else host.append(svg);
	};
	if (connector.hasAttribute("x1")) {
		const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((key) => parseFloat(connector.getAttribute(key)));
		draw(connector.parentElement, x1, y1, x2, y2, connector.getAttribute("route") ?? "straight", 10, 10, true);
	} else {
		const w = px(connector.style.width) ?? 64, h = px(connector.style.height) ?? 0;
		connector.style.position = "relative";
		connector.style.width = `${w}px`; connector.style.height = `${Math.max(h, 2)}px`;
		draw(connector, 0, h / 2 || 1, w, h / 2 || 1, "straight", w, Math.max(h, 2));
	}
}
// A moving part is its own small page. It is loaded when its slide is opened, not before.
for (const embed of [...document.querySelectorAll("x-embed")]) {
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("tabindex", "-1");
	frame.dataset.page = embed.innerHTML;
	frame.title = (embed.innerHTML.match(/<title>([^<]*)<\\/title>/) ?? ["", "A moving part of the slide"])[1];
	frame.style.cssText = `${embed.getAttribute("style")};border:0;background:transparent;pointer-events:none`;
	if (embed.hasAttribute("data-build-in")) frame.setAttribute("data-build-in", embed.getAttribute("data-build-in"));
	embed.replaceWith(frame);
}

// A link on a slide opens in a tab of its own; clicking it does not also move to the next slide.
for (const link of document.querySelectorAll("#stage a[href]")) {
	link.target = "_blank";
	link.rel = "noopener";
	link.addEventListener("click", (event) => event.stopPropagation());
}
const stepOf = (element) => Number((element.getAttribute("data-build-in").match(/\\d+/) ?? ["0"])[0]);
const builds = sections.map((section) => [...section.querySelectorAll("[data-build-in]")]);
const last = builds.map((list) => Math.max(0, ...list.map(stepOf)));
const embedded = new URLSearchParams(location.search).has("embed");
const room = document.getElementById("room"), stage = document.getElementById("stage"), bar = document.getElementById("bar");
const said = document.getElementById("said"), jump = document.getElementById("jump"), total = document.getElementById("total");
const back = document.getElementById("back"), next = document.getElementById("next"), leave = document.getElementById("leave");
let slide = 0, step = 0;

const show = (fresh) => {
	sections.forEach((section, index) => section.classList.toggle("off", index !== slide));
	for (const frame of sections[slide].querySelectorAll("iframe")) if (!frame.srcdoc) frame.srcdoc = frame.dataset.page;
	for (const element of builds[slide]) element.classList.toggle("later", stepOf(element) > step);
	// A slide just opened shows its first picture at once: only a step taken on it animates.
	if (fresh) { void stage.offsetWidth; }
	const lines = SAID[slide];
	said.textContent = lines.length === 1 ? lines[0] : lines[step] ?? "";
	if (document.activeElement !== jump) jump.value = String(slide + 1);
	total.textContent = `/ ${sections.length}`;
	back.disabled = slide === 0 && step === 0;
	next.disabled = slide === sections.length - 1 && step === last[slide];
	history.replaceState(null, "", `${location.pathname}${location.search}#${slide + 1}`);
};
const forward = () => {
	if (step < last[slide]) { step += 1; show(false); }
	else if (slide < sections.length - 1) { slide += 1; step = 0; show(true); }
};
const backward = () => {
	if (step > 0) { step -= 1; show(false); }
	else if (slide > 0) { slide -= 1; step = last[slide]; show(true); }
};
const place = () => {
	const width = document.documentElement.clientWidth;
	const height = document.documentElement.clientHeight - bar.offsetHeight;
	const scale = Math.min(width / 1920, height / 1080);
	room.style.height = `${height}px`;
	stage.style.transform = `scale(${scale})`;
	stage.style.left = `${(width - 1920 * scale) / 2}px`;
	stage.style.top = `${(height - 1080 * scale) / 2}px`;
};
const close = () => { if (embedded) parent.postMessage({ type: "premise-slides-close" }, location.origin); };

next.addEventListener("click", forward);
back.addEventListener("click", backward);
room.addEventListener("click", forward);
// Going to a typed slide number: anything that is not a number of a slide puts the current one back.
const goTo = (value) => {
	const asked = Number(value);
	if (Number.isInteger(asked) && asked >= 1 && asked <= sections.length && asked - 1 !== slide) { slide = asked - 1; step = 0; show(true); }
	jump.value = String(slide + 1);
};
jump.addEventListener("click", (event) => event.stopPropagation());
jump.addEventListener("focus", () => jump.select());
jump.addEventListener("keydown", (event) => {
	event.stopPropagation();
	if (event.key === "Enter") { event.preventDefault(); goTo(jump.value.trim()); jump.blur(); }
	else if (event.key === "Escape") { event.preventDefault(); jump.value = String(slide + 1); jump.blur(); }
});
jump.addEventListener("blur", () => { jump.value = String(slide + 1); });
addEventListener("keydown", (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.target === jump) return;
	const onControl = event.target instanceof HTMLElement && event.target.closest("button, a") !== null;
	if (event.key === "ArrowRight" || event.key === "PageDown" || (event.key === " " && !onControl)) { event.preventDefault(); forward(); }
	else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); backward(); }
	else if (event.key === "Home") { slide = 0; step = 0; show(true); }
	else if (event.key === "End") { slide = sections.length - 1; step = last[slide]; show(true); }
	else if (event.key === "Escape") close();
});
if (embedded) {
	leave.textContent = "Close";
	leave.addEventListener("click", (event) => { event.preventDefault(); close(); });
}
const asked = Number(location.hash.slice(1));
if (Number.isInteger(asked) && asked >= 1 && asked <= sections.length) slide = asked - 1;
show(true);
place();
addEventListener("resize", place);
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(place);
</script></body></html>
"""
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page.replace("__LINKS__", links).replace("__SLIDES__", "\n".join(sources)).replace("__ICONS__", json.dumps(icons)).replace("__SAID__", json.dumps(told, ensure_ascii=False)))
print(f"{out}: {len(order)} slides, {out.stat().st_size // 1024} KB")
