#!/usr/bin/env python3
"""Builds a local preview page for a deck's slide files: an approximation of how the Slides page
lays a slide out, good enough to see overflow, collisions and spacing. Not the real renderer:
icons are stand-ins from another icon set, and builds are shown all at once.

    python3 -I preview.py <root> <out.html>

<root> holds project/deck.json and project/slides/<id>.html. Open <out.html>?s=<id> for one slide
at full size (scaled to the window), or with no query for a contact sheet of them all.
Add &builds=1 to number the elements that build in.
"""
import json
import sys
from pathlib import Path

root, out = Path(sys.argv[1]), Path(sys.argv[2])
deck = json.loads((root / "project/deck.json").read_text())
icons = json.loads((Path(__file__).parent / "icons.json").read_text())
order = list(deck["order"])
for path in sorted((root / "project/slides").glob("*.html")):
    if path.stem not in order:
        order.append(path.stem)
slides = "\n".join((root / f"project/slides/{slide}.html").read_text() for slide in order if (root / f"project/slides/{slide}.html").exists())
links = "\n".join(f'<link rel="stylesheet" href="{face["href"]}">' for face in deck.get("faces", {}).values() if "href" in face)

page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Deck preview</title>
__LINKS__
<style>
html, body { margin: 0; background: #6b7078; }
#stage { position: relative; }
.frame { position: absolute; overflow: hidden; background: #000; }
section { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; transform-origin: 0 0; }
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
.caption { position: absolute; left: 0; font: 600 13px/1.2 ui-monospace, monospace; color: #fff; }
.badge { position: absolute; font: 700 22px/32px ui-monospace, monospace; width: 32px; height: 32px; text-align: center; background: #6d28d9; color: #fff; border-radius: 16px; }
</style></head><body><div id="stage">
__SLIDES__
</div>
<script>
const ICONS = __ICONS__;
const params = new URLSearchParams(location.search);
const only = params.get("s");
const sections = [...document.querySelectorAll("#stage > section")];
const px = (value) => (value == null || value === "" ? null : parseFloat(value));

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
	if (kind === "line") { shape.style.height = shape.style.height || "2px"; }
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
		for (const key of ["data-build-in", "data-build-out"]) if (connector.hasAttribute(key)) svg.setAttribute(key, connector.getAttribute(key));
		if (inPlace) connector.replaceWith(svg); else host.append(svg);
	};
	if (connector.hasAttribute("x1")) {
		const host = connector.parentElement;
		const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((key) => parseFloat(connector.getAttribute(key)));
		draw(host, x1, y1, x2, y2, connector.getAttribute("route") ?? "straight", 10, 10, true);
	} else {
		const w = px(connector.style.width) ?? 64, h = px(connector.style.height) ?? 0;
		connector.style.position = "relative";
		connector.style.width = `${w}px`; connector.style.height = `${Math.max(h, 2)}px`;
		draw(connector, 0, h / 2 || 1, w, h / 2 || 1, "straight", w, Math.max(h, 2));
	}
}
for (const embed of document.querySelectorAll("x-embed")) {
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.srcdoc = embed.innerHTML;
	frame.style.cssText = `${embed.getAttribute("style")};border:0;background:transparent`;
	embed.replaceWith(frame);
}
if (params.get("builds")) {
	for (const element of document.querySelectorAll("[data-build-in]")) {
		const badge = document.createElement("div");
		badge.className = "badge";
		badge.textContent = (element.getAttribute("data-build-in").match(/\\d+/) ?? ["?"])[0];
		const box = element.getBoundingClientRect(), frame = element.closest("section").getBoundingClientRect(), k = frame.width / 1920;
		const first = element.tagName.toLowerCase() === "svg" && element.firstElementChild ? element.firstElementChild.getBoundingClientRect() : box;
		badge.style.left = `${Math.max(0, (first.left - frame.left) / k - 12)}px`;
		badge.style.top = `${Math.max(0, (first.top - frame.top) / k - 12)}px`;
		element.parentElement.append(badge);
	}
}
const stage = document.getElementById("stage");
const place = () => {
	if (only) {
		const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
		for (const section of sections) {
			section.classList.toggle("off", section.id !== only);
			section.style.transform = `scale(${scale})`;
		}
		return;
	}
	const columns = Number(params.get("cols") ?? 3), gap = 14, label = 18;
	const scale = (innerWidth - gap * (columns + 1)) / columns / 1920;
	sections.forEach((section, index) => {
		const col = index % columns, row = Math.floor(index / columns);
		section.style.left = `${gap + col * (1920 * scale + gap)}px`;
		section.style.top = `${gap + label + row * (1080 * scale + gap + label)}px`;
		section.style.transform = `scale(${scale})`;
		let caption = document.getElementById(`cap-${section.id}`);
		if (!caption) { caption = document.createElement("div"); caption.id = `cap-${section.id}`; caption.className = "caption"; caption.textContent = `${index + 1} · ${section.id}`; stage.append(caption); }
		caption.style.left = section.style.left;
		caption.style.top = `${gap + row * (1080 * scale + gap + label)}px`;
	});
	stage.style.height = `${gap + Math.ceil(sections.length / columns) * (1080 * scale + gap + label)}px`;
};
place();
addEventListener("resize", place);
// Reports text that overflows its own box, or flow content that runs past the slide: the things a screenshot shows.
window.overflowReport = () => {
	const found = [];
	for (const section of sections) {
		if (only && section.id !== only) continue;
		const scale = section.getBoundingClientRect().width / 1920, box = section.getBoundingClientRect();
		for (const element of section.querySelectorAll("h1,h2,h3,p,li,div,x-icon,x-shape,svg")) {
			if (element.closest("aside") || element.closest("svg") !== null && element.tagName !== "svg" || getComputedStyle(element).display === "none") continue;
			const r = element.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			const right = (r.right - box.left) / scale, bottom = (r.bottom - box.top) / scale, left = (r.left - box.left) / scale, top = (r.top - box.top) / scale;
			const words = (element.textContent || "").trim().slice(0, 40);
			if (right > 1921 || bottom > 1081 || left < -1 || top < -1) found.push({ slide: section.id, problem: "outside the canvas", at: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)], words });
			else if (["H1", "H2", "H3", "P"].includes(element.tagName) && (element.scrollWidth > element.clientWidth + 2 || (element.style.height && element.scrollHeight > element.clientHeight + parseFloat(getComputedStyle(element).fontSize) * 0.35))) found.push({ slide: section.id, problem: "text overflows its box", at: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)], words });
			else if (["H1", "H2", "H3", "P"].includes(element.tagName) && !element.style.position && bottom > 921 && /padding:128px 128px 160px/.test(section.getAttribute("style")) && !element.closest('[style*="bottom:64px"]')) found.push({ slide: section.id, problem: "flow text passes y 920 (the footer band)", at: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)], words });
		}
	}
	return found;
};
if (params.get("report")) {
	const show = () => { const pre = document.createElement("pre"); pre.id = "report"; pre.textContent = JSON.stringify(window.overflowReport()); document.body.append(pre); };
	(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(show, 300));
}
</script></body></html>
"""
out.write_text(page.replace("__LINKS__", links).replace("__SLIDES__", slides).replace("__ICONS__", json.dumps(icons)))
print(f"{out}: {len(order)} slides")
