#!/bin/bash
# Removes the staging Worker and everything it made on Cloudflare (see wrangler.staging.jsonc and
# `npm run deploy:staging`): every repo in its Artifacts namespace, its Workflow, and the Worker
# with its Durable Objects. The names are fixed here and are never the production ones.
# It lists what it will delete and asks before deleting anything. Nothing local is touched.
#
#   bash scripts/staging-teardown.sh
set -euo pipefail

NAMESPACE="premise-staging"
WORKER="premise-staging"
WORKFLOW="premise-agent-staging"
for name in "$NAMESPACE" "$WORKER" "$WORKFLOW"; do
	case "$name" in
	*-staging) ;;
	*) echo "refusing: \"$name\" is not a staging name" >&2; exit 1 ;;
	esac
done

# The names of the repos in the staging namespace. Wrangler lists at most 50 at a time.
list_repos() {
	npx wrangler artifacts repos list --namespace "$NAMESPACE" --json 2>/dev/null | node -e '
let text = ""; process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
	let rows = []; try { rows = JSON.parse(text); } catch {}
	console.log((Array.isArray(rows) ? rows : []).map((row) => row.name).join("\n"));
});'
}
repos="$(list_repos)"
count="$(printf '%s\n' "$repos" | grep -c . || true)"
more=""
[ "$count" -ge 50 ] && more=" (at least; wrangler lists 50 at a time, and the rest are deleted the same way)"

echo "This will permanently delete, on Cloudflare:"
echo "  - $count repos in the Artifacts namespace \"$NAMESPACE\"$more:"
printf '%s\n' "$repos" | grep . | awk '{ if ($1 ~ /^trunk/) print "      " $1; else forks++ } END { if (forks) print "      and " forks " Intent forks" }'
echo "  - the Workflow \"$WORKFLOW\" and its instances"
echo "  - the Worker \"$WORKER\" and its Durable Objects (its board, ledger and kept runs)"
echo "The production Worker \"premise\", its namespace \"premise\" and its Workflow are not touched."
read -r -p "Type yes to delete: " answer
[ "$answer" = "yes" ] || { echo "Nothing was deleted."; exit 0; }

# A page at a time, until the staging namespace is empty (at most 40 pages, so it cannot loop for ever).
deleted=0
for _ in $(seq 1 40); do
	[ "$(printf '%s\n' "$repos" | grep -c . || true)" -gt 0 ] || break
	printf '%s\n' "$repos" | grep . | xargs -P 6 -I{} npx wrangler artifacts repos delete {} --namespace "$NAMESPACE" --force > /dev/null
	deleted=$((deleted + $(printf '%s\n' "$repos" | grep -c .)))
	repos="$(list_repos)"
done
echo "Deleted $deleted repos."
npx wrangler workflows delete "$WORKFLOW" || echo "The Workflow could not be deleted (it may be gone already)."
npx wrangler delete "$WORKER" --config wrangler.staging.jsonc || echo "The Worker could not be deleted (it may be gone already)."
left="$(npx wrangler artifacts repos list --namespace "$NAMESPACE" --json 2>/dev/null | node -e 'let t="";process.stdin.on("data",(c)=>(t+=c)).on("end",()=>{try{console.log(JSON.parse(t).length)}catch{console.log("?")}})')"
echo "Repos left in \"$NAMESPACE\": $left. (The empty namespace itself stays listed; wrangler has no command to remove one.)"
