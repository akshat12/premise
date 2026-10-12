# Submission checklist

Deadline: **Wednesday Oct 14 2026, 11:59 PM PDT.** Target: **Oct 14, 6:00 PM PDT**, to leave a margin.

Owner of every item is **Akshat** unless it says otherwise. "Claude can do this" means a coding session can do the step once Akshat says go; the decision is still Akshat's.

**The form must be filled in and submitted by a person.** The official rules do not allow entries made by automated means, so no script or agent submits it.

## After the Oct 11 review (do these first, in order)

Four reviewer passes on Oct 11 led to changes in the gate, the comparison and the demo scenario (see `docs/DECISIONS.md`, Oct 11). The code is committed and tested locally. What is left needs the deployed Worker:

| | Item | Owner | Link or command |
|---|---|---|---|
| [x] | Publish the updated `demo-repo/` to its public GitHub repo. Done Oct 11. | Claude | `scripts/publish-demo-repo.sh akshat12/acme-accounts` |
| [x] | Deploy the Worker. Done Oct 11. | Claude | `npm run deploy` |
| [x] | Run the three-rule comparison on real Artifacts. Done Oct 11, and again Oct 12 on the final build (`docs/ab-results.*`); the three headline rows came out the same. | Claude | `npx tsx scripts/ab.ts --url https://premise.akshatdivekar.workers.dev --n 100 --seeds 7,11,23` |
| [x] | Make the demo recordings again. Done Oct 11: `demo/runs/main.json` is four agents (the front page), `demo/runs/scale.json` is twelve agents and 294 workload Intents (the At scale tab, and `/?demo=scale`). | Claude | `npm run demo:record -- --url <worker> --out demo/runs/main.json --tasks t01,t02,t04,t11 --workload 0`, then `npm run demo:compress -- demo/runs/main.json` |
| [x] | One demo recording with a live model, published as `/?demo=live`. Done Oct 11 (four tasks, Gemini 3.5 Flash-Lite; all four landed and one regression reached trunk. The README says what happened, including a second run on Oct 12 that ended the same way). | Claude | `npm run demo:record` after `POST /api/admin/llm` |

## Before recording

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | **Publish this repo publicly on GitHub.** It has no remote yet. Decide the name (suggested: `premise`). Scans on Oct 10 and Oct 12 found no secrets in the tracked files or in the history (only the local test token, which is meant to be there; the Cloudflare account id in the `wrangler*.jsonc` files is an identifier, not a secret). | Akshat decides; Claude can do this | Mon Oct 12 | `gh repo create premise --public --source . --push` |
| [ ] | Put the repo address in the README's clone line, in `docs/video/shot-list.md` (shot 11) and in the end-frame address. | Akshat; Claude can do this | Mon Oct 12 | `README.md`, `docs/video/end-frame.html?repo=…` |
| [ ] | Create the two event subscriptions on the deployed Worker's queue (the demo does not depend on them; the "pushes from outside the gate" path does). Optional. | Akshat | Tue Oct 13 | The two `wrangler queues subscription create` commands in `README.md`, step 7 |
| [ ] | Dry run: every box in `docs/video/dry-run.md` down to "The read". | Akshat | Mon Oct 12 | [dry-run.md](video/dry-run.md) |
| [ ] | Read the script aloud once against `/?demo=main`; it comes to about 6:20, and must not be under 5:00. | Akshat | Mon Oct 12 | [script.md](video/script.md), [shot-list.md](video/shot-list.md) |

## The video

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | Record the shots in `shot-list.md`. | Akshat | Mon Oct 12 or Tue Oct 13 | [shot-list.md](video/shot-list.md) |
| [ ] | Edit. Check the "After recording" boxes in `dry-run.md`. | Akshat | Tue Oct 13, morning | [dry-run.md](video/dry-run.md) |
| [ ] | **Video exported as a file: MP4, WebM or MOV, at most 2 GiB. Length is between 5 and 10 minutes.** The form takes a file upload, not a link. An unlisted upload elsewhere is still useful for the README. | Akshat | Tue Oct 13, 6 PM PDT | File: ______ Link for the README: ______ |
| [ ] | Put the video link in the README ("See it in 2 minutes") and push. | Akshat; Claude can do this | Tue Oct 13 | `README.md` |

## The repo and the deployment

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | **The public GitHub repo has a LICENSE (MIT), the README and run instructions.** Open it logged out to check. | Akshat | Tue Oct 13 | Repo link: ______ |
| [ ] | **The deployed URL works in a private window.** `/` works without auth: it opens on "Step 01 / 07", and at step 4 Agents 2 and 4 are marked in orange as stopped, with Agent 3 untouched. | Akshat | Tue Oct 13, and again Wed Oct 14 before submitting | <https://premise.akshatdivekar.workers.dev/?demo=main> |
| [ ] | The deployed build is the published code: `git status` is clean, then `npm run deploy`. | Akshat; Claude can do this | Tue Oct 13 | `npm run deploy` |
| [ ] | A stranger's path works: on another machine or a fresh clone, the README's "Run it yourself" steps run. (Done on Oct 10 and again on Oct 12 from a clean local clone with no Cloudflare login; repeat from the public repo.) | Akshat | Tue Oct 13 | `README.md`, "Run it yourself" |

## Eligibility and submitting

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | **Every entrant is a US or Canada resident and 18 or older. One submission per entrant.** Read the official rules once more for anything this list misses. | Akshat | Tue Oct 13 | <https://www.cloudflare.com/git-competition/> |
| [ ] | **Submitted by hand** at the form: team name, contact, location, who would attend on Oct 21, the three texts below, the video file, the repo address, and the two checkboxes. Keep the confirmation. | Akshat | **Wed Oct 14, by 6:00 PM PDT** (hard deadline 11:59 PM PDT) | <https://www.cloudflare.com/git-competition/submit> |
| [ ] | Finalists present for 10 minutes on Oct 21, and the winner has to be there in person. Check you can be. | Akshat | Tue Oct 13 | [stage-10min.md](video/stage-10min.md) |

## Text for the form (drafts: edit before pasting)

**Project vision**

> Git tracks what agents wrote. Premise tracks what they assumed, and re-derives the work the moment an assumption breaks.
>
> When many agents change one codebase at once, the changes that hurt are the ones that rebase cleanly, typecheck, and are wrong, because another agent changed what the code relied on. In Premise each agent works on an Intent in its own Artifacts fork. The Intent records the symbols it changes and the symbols it relies on: what the agent read, what its code calls, and behaviour it states as an executable assertion. When something lands on trunk, every in-flight Intent whose premises no longer hold is told at once what changed and who changed it. A stale Intent tries a plain rebase first; if that does not pass the gate, its agent redoes the work on the new trunk. Nothing lands without a typecheck, the Intent's tests, reference checks the agent cannot write, every test already on trunk, and its assertions.
>
> In our comparison a queue that runs tests still ships one planted regression, the one whose tests use a stand-in for the function that changed. Its premise is what catches it. The scenario is constructed and the demo agents are scripted; the README says exactly what was and was not measured.

**How you used Cloudflare**

> - Artifacts: trunk and one fork per Intent (forks and reads through the Worker binding, writes as git over HTTPS with isomorphic-git and a short-lived token for that one fork). The larger demo recording made 309 forks and landed 266 Intents in about four minutes.
> - Workers: one Worker serves the API, the UI and the queue consumer. The TypeScript compiler runs inside it for typechecks and type-surface hashes.
> - Durable Objects (SQLite): the ledger, sharded by module path; one object per Intent; the gate, one per trunk; the event log with WebSocket fan-out.
> - Workflows: one durable run per agent, with waits for the ledger and for a person.
> - Dynamic Workers (Worker Loader): every test and assertion runs in its own isolate with no network.
> - Queues: wired for Artifacts event subscriptions (pushes to trunk from outside the gate). Implemented and tested; not exercised on the deployed Worker.
> - Kumo for the UI.

**Instructions to run your project**

> Needs Node 22.12 or later. No Cloudflare account and no model key:
>
> ```
> git clone <repo> premise && cd premise
> npm install
> cp local.vars.example .dev.vars
> npm run dev:local        # http://localhost:5173 plays the recorded run
> npm run demo             # in a second terminal: a live run with in-memory repos and scripted agents
> npm test
> ```
>
> Or open https://premise.akshatdivekar.workers.dev/ and press Next. Deploying to your own account on real Artifacts is in the README.

## After submitting

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | Do not reset or redeploy the Worker while judging may be under way, except to fix something broken. The recorded run does not depend on the Worker's state; the live board does. | Akshat | From Oct 14 | |
| [ ] | Rotate the Gemini API key used for the live-model runs, and update the Worker secret if more are wanted. | Akshat | Before the repo is public, or Thu Oct 15 at the latest | Google AI Studio, then `npx wrangler secret put GEMINI_API_KEY` |
| [ ] | Artifacts billing starts Oct 14. List the repos and delete what is not needed: a reset deletes the previous run's forks, but check for old `trunk-…` copies and `smoke-…` repos. | Akshat | Thu Oct 15 | `npx wrangler artifacts repos list --namespace premise` |
| [ ] | **Stage fallback for Oct 21:** the recorded run plays offline from a local build. Rehearse `docs/video/stage-10min.md` once with Wi-Fi off. | Akshat | Tue Oct 20 | `npm run demo:offline`, then <http://localhost:4173/?demo=main> |
