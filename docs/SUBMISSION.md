# Submission checklist

Deadline: **Wednesday Oct 14 2026, 11:59 PM PDT.** Target: **Oct 14, 6:00 PM PDT**, to leave a margin.

Owner of every item is **Akshat** unless it says otherwise. "Claude can do this" means a coding session can do the step once Akshat says go; the decision is still Akshat's.

## Before recording

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | **Publish this repo publicly on GitHub.** It has no remote yet. Decide the name (suggested: `premise`). A scan on Oct 10 found no secrets in the tracked files or in the history (only the local test token, which is meant to be there). | Akshat decides; Claude can do this | Sat Oct 10 | `gh repo create premise --public --source . --push` |
| [ ] | Put the repo address in the README's clone line, in `docs/video/shot-list.md` (shot 10) and in the end-frame address. | Akshat; Claude can do this | Sat Oct 10 | `README.md`, `docs/video/end-frame.html?repo=…` |
| [ ] | Create the two event subscriptions on the deployed Worker's queue (the demo does not depend on them; the "pushes from outside the gate" path does). | Akshat | Sat Oct 10 | The two `wrangler queues subscription create` commands in `README.md`, step 7 |
| [ ] | Dry run: every box in `docs/video/dry-run.md` down to "The read". | Akshat | Sun Oct 11 | [dry-run.md](video/dry-run.md) |
| [ ] | Read the script aloud once against `/?demo=main`; it lands between 7:30 and 9:00. | Akshat | Sun Oct 11 | [script.md](video/script.md), [shot-list.md](video/shot-list.md) |

## The video

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | Record the shots in `shot-list.md`. | Akshat | Mon Oct 12 | [shot-list.md](video/shot-list.md) |
| [ ] | Edit. Check the "After recording" boxes in `dry-run.md`. | Akshat | Tue Oct 13, morning | [dry-run.md](video/dry-run.md) |
| [ ] | **Video uploaded** (unlisted is fine). **Length is between 5 and 10 minutes.** | Akshat | Tue Oct 13, 6 PM PDT | Video link: ______ |
| [ ] | Put the video link in the README ("See it in 2 minutes") and push. | Akshat; Claude can do this | Tue Oct 13 | `README.md` |

## The repo and the deployment

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | **The public GitHub repo has a LICENSE (MIT), the README and run instructions.** Open it logged out to check. | Akshat | Tue Oct 13 | Repo link: ______ |
| [ ] | **The deployed URL works in a private window.** `/?demo=main` works without auth: press `→` twice and three strips are red. | Akshat | Tue Oct 13, and again Wed Oct 14 before submitting | <https://premise.akshatdivekar.workers.dev/?demo=main> |
| [ ] | The deployed build is the published code: `git status` is clean, then `npm run deploy`. | Akshat; Claude can do this | Tue Oct 13 | `npm run deploy` |
| [ ] | A stranger's path works: on another machine or a fresh clone, the README's "Local only" steps run. (Done once on Oct 10 from a clean clone with no Cloudflare login; repeat from the public repo.) | Akshat | Tue Oct 13 | `README.md`, "Run it yourself" |

## Eligibility and submitting

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | **Every entrant is a US or Canada resident and 18 or older. One submission per entrant.** Read the official rules once more for anything this list misses. | Akshat | Tue Oct 13 | <https://www.cloudflare.com/git-competition/> |
| [ ] | **Submitted** at the form, with the repo link, the video link and the deployed URL. Keep the confirmation. | Akshat | **Wed Oct 14, by 6:00 PM PDT** (hard deadline 11:59 PM PDT) | <https://www.cloudflare.com/git-competition/submit> |

## After submitting

| | Item | Owner | When | Link or command |
|---|---|---|---|---|
| [ ] | Do not reset or redeploy the Worker while judging may be under way, except to fix something broken. The recorded run does not depend on the Worker's state; the live board does. | Akshat | From Oct 14 | |
| [ ] | Rotate the Gemini API key (it was pasted into a chat once) and update the Worker secret if live-model runs are still wanted. | Akshat | Thu Oct 15 | Google AI Studio, then `npx wrangler secret put GEMINI_API_KEY` |
| [ ] | Artifacts billing starts Oct 14. List the repos and delete what is not needed: a reset deletes the previous run's forks, but check for old `trunk-…` copies and `smoke-…` repos. | Akshat | Thu Oct 15 | `npx wrangler artifacts repos list --namespace premise` |
| [ ] | **Stage fallback for Oct 21:** the recorded run plays offline from a local build. Rehearse `docs/video/stage-10min.md` once with Wi-Fi off. | Akshat | Tue Oct 20 | `npm run demo:offline`, then <http://localhost:4173/?demo=main> |
