# T24: README, licence, run instructions and architecture diagram

## Goal
Make the repo submittable. A judge must be able to understand Premise in 60 seconds and run it in 10 minutes. The rules require an MIT, Apache or BSD licence with a LICENSE file. We use MIT.

## Read first
- `docs/SPEC.md`
- `docs/DECISIONS.md`
- `docs/ab-results.md`
- `CLAUDE.md`: vocabulary

## Deliverables

### `README.md`
1. **Title and tagline.** Use the "Git tracks what agents wrote…" line.
2. **The 20-second idea.** A three-bullet version of: Intent, premises (changes / relies on), invalidation, re-derive.
3. **A/B results table.** Copy it from `docs/ab-results.md`, with the date and the run parameters.
4. **"See it in 2 minutes".** Point to `/?demo=main` on the deployed URL, plus the video link (placeholder for now).
5. **Architecture.** An inline SVG or Mermaid diagram in `docs/architecture.svg` showing:
   - Artifacts: trunk, forks, push events, fork events
   - Queues
   - The EventHub, IntentDO, LedgerShard (sharded) and Landing Durable Objects
   - AgentWorkflow
   - The Dynamic Worker runner
   - TypeScript in the Worker
   - The Kumo UI
6. **How premises work.** Explain the three sources, why the surface hash ignores function bodies, and why behaviour lives in assertions. Include the honest line: "Premises are the early warning; the gate is the guarantee."
7. **Run it yourself.**
   - Prerequisites: Workers Paid plan, Node 22+, and an Anthropic key (optional; scripted mode works without one).
   - Exact commands, in order:
     1. `npm i`
     2. `wrangler login`
     3. Create the queue.
     4. Create the 2 event subscriptions.
     5. Set the secrets.
     6. `npm run deploy`
     7. Import the trunk.
     8. `npm run demo`
   - Local-only mode: `REPO_STORE=memory LLM=scripted npm run dev`.
8. **Limitations.** Be honest:
   - TypeScript only.
   - Workload agents are scripted.
   - Push enforcement happens after the push (Artifacts has no pre-receive hook).
   - The gate serializes landings on one Durable Object per trunk.
9. **Licence.** MIT.

### Other files
- **`package.json`:** add `"demo": "tsx scripts/record-run.ts ..."`, or a wrapper that opens `/?demo=main`. Also set `"license": "MIT"`.
- **`LICENSE`:** confirm it exists and contains the MIT text.
- **`.gitignore`:** confirm `docs/vendor/`, `.dev.vars`, `.env` and `spikes/node_modules` are ignored.

## Acceptance
- A clean clone into a temp directory, followed by the README's local-only steps, works end to end. Run it and paste the output.
- `grep -ri "merge queue\|pull request" README.md src/ui` returns nothing.
- `git ls-files | grep -E "dev.vars|\.env$"` returns nothing.
