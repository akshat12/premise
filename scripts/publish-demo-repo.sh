#!/usr/bin/env bash
# Publishes demo-repo/ as its own public GitHub repo, which Artifacts then imports as trunk.
# Nothing it writes to GitHub (commit messages, description) says what the repo is used for.
#
#   scripts/publish-demo-repo.sh <owner>/<name>        e.g. scripts/publish-demo-repo.sh akshat12/acme-accounts
#
# demo-repo/ lives inside this repo, so it is exported to a temporary directory first; that avoids a
# git repo nested inside a git repo. The first run creates the GitHub repo. Later runs add a commit.
set -euo pipefail

target="${1:?usage: scripts/publish-demo-repo.sh <owner>/<name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

exists=0
if gh repo view "$target" >/dev/null 2>&1; then
	exists=1
	# Works for an empty repo too: the clone then has no commits yet.
	gh repo clone "$target" "$work/repo" -- --quiet 2>/dev/null
	find "$work/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
	git -C "$work/repo" checkout --quiet -B main 2>/dev/null || git -C "$work/repo" symbolic-ref HEAD refs/heads/main
else
	mkdir "$work/repo"
	git -C "$work/repo" init --quiet --initial-branch=main
fi

# Copy everything except installed packages.
(cd "$root/demo-repo" && tar --exclude=node_modules -cf - .) | (cd "$work/repo" && tar -xf -)

git -C "$work/repo" add -A
if git -C "$work/repo" diff --cached --quiet; then
	echo "Nothing to publish: $target already matches demo-repo/."
	exit 0
fi

if git -C "$work/repo" rev-parse --verify HEAD >/dev/null 2>&1; then
	message="acme-accounts: update"
else
	message="acme-accounts: initial"
fi
git -C "$work/repo" commit --quiet -m "$message"

if [ "$exists" = 1 ]; then
	git -C "$work/repo" push --quiet origin HEAD:main
else
	gh repo create "$target" --public --source="$work/repo" --push \
		--description "A small TypeScript accounts and billing core."
fi

echo "Published https://github.com/$target"
echo "If the name differs from DEMO_REPO_URL in wrangler.jsonc, update it there and in wrangler.test.jsonc."
