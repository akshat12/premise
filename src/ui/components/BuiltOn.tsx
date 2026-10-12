import { CloudflareLogo } from "@cloudflare/kumo";

/** The line under the page saying what this runs on. */
export function BuiltOn() {
	return (
		<div className="flex items-center gap-2" style={{ padding: "8px 16px", fontSize: 12, color: "var(--ink-soft)" }}>
			<CloudflareLogo variant="glyph" className="h-4 w-auto" />
			Built on Cloudflare Workers + Artifacts
		</div>
	);
}
