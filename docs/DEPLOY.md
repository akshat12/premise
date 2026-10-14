# Deploy your own Premise

This puts Premise on **your own** Cloudflare account. You use your own account, your own admin token, and, if you want real AI agents, your own model key. Nothing here uses the author's account.


Needs the Workers Paid plan (Artifacts requires it) and Node 22.12 or later. A model key is optional: without one the agents replay scripted turns.

1. Install and log in.
   ```bash
   npm install
   npx wrangler login
   ```
2. Nothing to change for your account: `npm run deploy` deploys to whichever account `wrangler login` signed in to. (Only if you will use Workers AI as the model, put your own account id, from `npx wrangler whoami`, in `CLOUDFLARE_ACCOUNT_ID` in `wrangler.jsonc`.)
3. Create the queue.
   ```bash
   npx wrangler queues create premise-events
   ```
4. Deploy. The URL it prints is `<your worker>` below.
   ```bash
   npm run deploy
   ```
5. Set the secrets. Choose any long random string as the admin token.
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put GEMINI_API_KEY       # optional; see "Using a real model"
   ```
   Put the same admin token in a git-ignored file so the scripts can use it: `echo "ADMIN_TOKEN=<your token>" > .env.deployed`
6. Import trunk. This imports the demo repo ([akshat12/acme-accounts](https://github.com/akshat12/acme-accounts), a copy of `demo-repo/`) into Artifacts.
   ```bash
   curl -X POST <your worker>/api/admin/import-trunk -H "x-admin-token: <your token>"
   ```
7. Create the two event subscriptions.
   ```bash
   npx wrangler queues subscription create premise-events --source artifacts --events repo.created,repo.forked,repo.imported,repo.deleted --name premise-account
   npx wrangler queues subscription create premise-events --source artifacts.repo --events pushed --source-namespace premise --source-repo-name trunk --name premise-trunk-push
   ```
   The second one covers the repo named `trunk`. A demo reset moves trunk to a fresh repo (`trunk-<time>`), which this subscription does not cover, so after a reset a push from outside the gate is not seen until a subscription is made for the new repo.
8. Run the demo.
   ```bash
   npm run demo -- --url <your worker>
   ```

**The Start button on your own deployment.** `POST /api/live/start` takes no token and no parameters, so anyone who finds your Worker can start a run. What a run can cost is bounded in `src/worker/live/public-run.ts`: one at a time, three minutes between starts, ten in any 24 hours, scripted agents only (it is refused while `LLM` is a model), about 45 forks each. Every batch of tests a run makes is one Dynamic Worker, which Cloudflare bills by the number created in a day, so the daily cap is also what bounds that part of the bill. To switch it off or on without a deploy:

```bash
curl -X POST <your worker>/api/admin/public-runs -H "x-admin-token: <your token>" -H "content-type: application/json" -d '{"enabled":false}'
```

**The owner's tools are hidden from visitors.** "Dispatch tasks", "Run workload" and "Reset demo" appear under More only when the address has `admin` in it (`<your worker>/?live&admin`), or once the admin token has been typed in that browser session. They pick which tasks run, add a workload of any size, and clear the board; each asks for the admin token. `npm run demo` opens the page that way.

Switch it off before you show a run to a room, record one, or switch the agents to a model: a visitor cannot interrupt a run in progress, but may start the next one the moment yours has ended. `scripts/ab.ts` does this by itself. `{"enabled":true,"clear":true}` also gives the day's runs back.

Other commands:

| Command | What it does |
|---|---|
| `PREMISE_URL=<your worker> npm run smoke` | Runs the repo-store contract against real Artifacts on the deployed Worker |
| `npx tsx scripts/ab.ts --url <your worker> --seeds 7,11,23` | Runs the A/B comparison (one seed, 7, if `--seeds` is left out) and rewrites `docs/ab-results.md` and `.json` |
| `npm run demo:record -- --url <your worker> --out demo/runs/mine.json` | Records a run. Recordings are bundled at build time, so play it at `/?demo=mine` locally, or after the next deploy |
| `npm run deploy:staging` | Deploys the same code as a second Worker, `premise-staging`, with its own Artifacts namespace and Workflow (`wrangler.staging.jsonc`), to try a change on real Artifacts before production gets it. It has no admin token unless you set one (`npx wrangler secret put ADMIN_TOKEN --name premise-staging`) |
| `bash scripts/staging-teardown.sh` | Lists and, once you type `yes`, deletes everything the staging Worker made: the repos in its namespace, its Workflow, and the Worker itself |
| `npm run demo:compress -- demo/runs/mine.json` | Cuts idle time out of a recording and marks each cut |
| `npm run demo:offline` | Builds, then serves the UI as plain files with no backend: the recorded run at `http://localhost:4173/?demo=main` |


## Using a real model


Set `LLM` to a provider and give it a key. Nothing else changes.

| `LLM` | Key |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `workers-ai` | `CLOUDFLARE_API_TOKEN` |
| `scripted` | none |

Locally, put both in `.dev.vars`. Deployed, set the key with `wrangler secret put`, then choose the provider without a redeploy:

```bash
curl -X POST <your worker>/api/admin/llm -H "x-admin-token: <your token>" -H "content-type: application/json" -d '{"provider":"google","model":"gemini-3.5-flash-lite"}'
```

