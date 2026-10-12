import { CloudflareLogo } from "@cloudflare/kumo";

/** The line under the page saying what this runs on. */
export function BuiltOn() {
	return (
		<div className="label builton">
			<CloudflareLogo variant="glyph" className="h-4 w-auto" />
			Built on Cloudflare Workers + Artifacts
		</div>
	);
}
