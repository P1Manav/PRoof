# Receipts — Build Plan, Setup Guide & Agentic Development Prompt

A GitHub bot that logs your own commit-time confidence claims, audits your PR descriptions and docs at review time, and quotes your own claims back at you later if the code breaks or gets reverted.

---

## 1. Product overview

**Core loop:** commit → confidence score logged locally → PR opened → bot audits description/docs/confidence in one comment → CI fails or PR gets reverted later → bot posts a follow-up quoting your original claim, timestamped.

## 2. Scope

### v1 (MVP) — single repo, no backend, no auth beyond the default Action token
- Post-commit confidence logger (stored via `git notes`)
- GitHub Action that posts one PR comment covering: lowest confidence score in the PR, description-vs-diff mismatch heuristic, README/docs staleness
- Follow-up "receipts" comment triggered on CI failure or PR revert

### v2 — installable GitHub App, cross-repo/team
- OAuth GitHub App registration (installable by others with one click)
- Hosted webhook receiver + database
- Opt-in leaderboard/dashboard
- LLM-powered (Claude API) description judgment replacing the v1 heuristic

**Non-goals for v1:** no dashboard, no multi-repo aggregation, no user accounts, no mobile app. Don't build any of this until v1 has been dogfooded for a couple of weeks.

## 3. Architecture (v1)

```
[Local machine]                          [GitHub Cloud]
git commit
  → post-commit hook (Node script)
      → prompts confidence 1–10
      → git notes add -r receipts -m '{...}' <sha>
  → git push (notes pushed via refspec)
                                           → PR opened/synchronize
                                              → receipts-pr.yml fires
                                                 → reads git notes for commits in PR
                                                 → runs description-vs-diff heuristic
                                                 → runs README staleness check
                                                 → posts/updates one PR comment (Octokit)
                                           → CI completes / PR merged or reverted
                                              → receipts-followup.yml fires
                                                 → reads .receipts/log.jsonl (receipts-data branch)
                                                 → compares claim against outcome
                                                 → posts follow-up comment quoting original claim
```

## 4. Data model

**Git note** (per commit, namespace `refs/notes/receipts`):
```json
{"sha": "abc123", "confidence": 8, "timestamp": "2026-08-13T10:00:00Z", "author": "manav"}
```

**`.receipts/log.jsonl`** (append-only, one line per PR audit; lives on a dedicated `receipts-data` branch so it never clutters `main`):
```json
{"pr": 42, "sha_range": ["abc123","def456"], "min_confidence": 8, "desc_flag": false, "readme_stale_days": 12, "posted_comment_id": 987654, "created": "2026-08-13T10:05:00Z"}
```

## 5. Repo structure

```
receipts/
├── hook/
│   ├── post-commit          # bash wrapper, calls log-confidence.js
│   └── log-confidence.js    # prompts confidence, writes git note
├── bin/
│   └── receipts.js          # CLI: `receipts log`
├── .github/workflows/
│   ├── receipts-pr.yml
│   └── receipts-followup.yml
├── action/
│   ├── pr-audit.js
│   ├── followup.js
│   └── lib/
│       ├── notes.js
│       ├── heuristics.js
│       └── github.js
├── install.sh
├── package.json
└── README.md
```

## 6. Tech stack

- Node.js 20+ (TypeScript optional for the Action code once you're past Phase 1)
- `@actions/core`, `@actions/github` (Octokit) for the Action
- No database in v1 — git notes + a jsonl file is the entire persistence layer
- No external deps at all for the local hook — Node's built-in `child_process` and `readline` are enough

## 7. Milestones (solo, part-time pace)

| When | What |
|---|---|
| Weekend 1 | Hook + local git notes working end-to-end on your own repo, verified with `git notes show` |
| Week 2 | `receipts-pr.yml` posts a real comment on a real PR — ship just "lowest confidence" first |
| Week 3 | Add description-vs-diff heuristic + README staleness to the same comment |
| Week 4 | Follow-up mechanic — trigger on `workflow_run` completion, read the log, post the receipts comment |
| Week 5 | Dogfood on 2–3 of your own real repos, tune false positives |
| Later | v2 GitHub App — only once v1 has survived a few weeks of real use without you disabling it |

## 8. Validate before building v2

- You've kept using it yourself for 2+ weeks without turning it off
- A couple of classmates/friends who tried it on their own repos want to keep it
- False-positive rate on the README/description heuristics is low enough not to be annoying

---

## Setup & development guide

### Prerequisites
- Node.js 20+, npm or pnpm
- A GitHub account + a throwaway test repo (don't build against a real project first)
- GitHub CLI (`gh`), authenticated
- Optional: [`act`](https://github.com/nektos/act) to run Actions locally in Docker instead of pushing every time

### Steps

1. **Scaffold**
   ```bash
   mkdir receipts && cd receipts
   npm init -y
   npm install @actions/core @actions/github
   git init
   ```

2. **Build the hook** (`hook/log-confidence.js`) — use `readline` to prompt for a 1–10 score after commit, then shell out to `git notes --ref=receipts add -f -m '<json>' HEAD`. Wrap it in `hook/post-commit` (bash, just calls the Node script).

3. **Write `install.sh`** — copies `hook/post-commit` into `.git/hooks/post-commit` of whatever repo it's run against, `chmod +x`s it. This is what you'll eventually tell other people to run.

4. **Push notes along with commits** — by default `git push` does *not* push notes. Either `git config --add remote.origin.push refs/notes/receipts:refs/notes/receipts`, or push explicitly: `git push origin refs/notes/receipts`.

5. **Write the PR Action** (`.github/workflows/receipts-pr.yml`) — trigger on `pull_request: [opened, synchronize]`. Use `actions/checkout` with `fetch-depth: 0`, then explicitly `git fetch origin refs/notes/receipts:refs/notes/receipts` (checkout doesn't pull notes by default). Run `action/pr-audit.js`, which uses Octokit + the auto-provided `GITHUB_TOKEN` (grant `permissions: pull-requests: write` in the workflow) to post/update a comment.

6. **Test** — `act pull_request` for fast local iteration, or just open real PRs against your throwaway repo (often faster than fighting `act`'s Docker quirks for something this simple).

7. **Add the follow-up workflow** (`.github/workflows/receipts-followup.yml`) — trigger on `workflow_run: [completed]` (matching your actual CI workflow name) plus `pull_request: [closed]` to catch reverts/merges. Reads `.receipts/log.jsonl` from `receipts-data`, matches the relevant PR, checks outcome, posts the follow-up.

8. **Dogfood** — install it on this very repo first. Let it roast you for a week before showing anyone else.

---

## Engineered prompt for an agentic coding tool (Claude Code, etc.)

Scoped deliberately to **Phase 1 only** — the local hook and confidence logging, no GitHub API at all. Get the agent to build and verify one working slice before handing it Phase 2 as a separate prompt. Agentic tools do much better with a tight, verifiable scope than an entire multi-week roadmap dumped in one message.

```
# Project: Receipts — Phase 1 (local git hook + confidence logging)

## Context
I'm building a small developer tool called "Receipts." The end goal (later
phases, not this one) is a GitHub Action that audits pull requests and later
"quotes back" a developer's own confidence claims if code they were
confident about breaks or gets reverted. This phase is ONLY the local
foundation: a git hook that captures a confidence score at commit time and
stores it using git notes.

## Goal for this phase
Build a working, tested, local-only tool with no GitHub API dependency yet:
1. A post-commit git hook that prompts the user for a confidence score
   (integer 1-10) immediately after every commit.
2. The score, plus commit SHA, ISO 8601 timestamp, and git user.name, gets
   stored as a git note in a dedicated namespace `refs/notes/receipts`, as
   JSON.
3. An install script that copies the hook into any target repo's
   `.git/hooks/post-commit`.
4. A CLI command (`receipts log`) that prints a human-readable table of
   every confidence score recorded so far in the current repo, reading
   directly from git notes.

## Tech constraints
- Node.js 20+, plain JavaScript (no TypeScript this phase — keep it
  minimal).
- No external dependencies beyond Node's built-ins (`child_process`,
  `readline`) unless you have a strong reason. This phase should not need
  `simple-git` or any GitHub API library.
- Must work on macOS and Linux; Windows support is not required for v1.

## Repo structure to create
receipts/
├── hook/
│   ├── post-commit
│   └── log-confidence.js
├── bin/
│   └── receipts.js
├── install.sh
├── package.json
└── README.md

## Exact behavior spec
- `hook/post-commit` is an executable bash script that calls
  `node "$(dirname "$0")/log-confidence.js"`.
- `log-confidence.js`:
  - Gets the current commit SHA via `git rev-parse HEAD`.
  - Prompts interactively: `Confidence this commit works (1-10): `. Reject
    non-integer or out-of-range input and re-prompt once; if invalid twice,
    skip logging without failing the commit — this must NEVER block a
    commit.
  - Gets the git user name via `git config user.name`.
  - Writes the note via
    `git notes --ref=receipts add -f -m '<json>' <sha>` where json is
    `{"sha":"...","confidence":N,"timestamp":"...","author":"..."}`.
  - Must skip prompting (and just exit cleanly, unlogged) when stdin isn't
    interactive — detect via `process.stdin.isTTY` — so this never breaks
    scripted or automated commits.
- `install.sh`:
  - Takes an optional target path argument (default: current directory).
  - Copies `hook/post-commit` and `hook/log-confidence.js` into
    `<target>/.git/hooks/`.
  - `chmod +x`s the hook.
  - Errors clearly if `<target>/.git` doesn't exist.
- `bin/receipts.js` (wired up as the `receipts` bin in package.json):
  - `receipts log` subcommand: walks `git log` for all commit SHAs,
    cross-references each with `git notes --ref=receipts show <sha>`
    (skipping commits with no note), and prints a table — short SHA,
    confidence, author, relative time ("2 days ago") — newest first.
  - Prints "No confidence scores recorded yet." if there are none. Don't
    error out.

## What I want you to do
1. Set up the repo structure above.
2. Implement everything in the spec.
3. Write a short section in README.md covering how to install the hook in
   a target repo and how `receipts log` works.
4. Test it end-to-end yourself: init a scratch git repo somewhere
   temporary, run install.sh against it, make a couple of commits
   (handling the non-interactive stdin path, since you're scripting this —
   confirm scripted commits are skipped gracefully), and run
   `receipts log` to confirm notes are written and read correctly. For the
   interactive prompt path, since you can't type into a live prompt
   yourself, walk through the code and describe what you'd expect to
   happen instead.
5. Do NOT start on the GitHub Action (Phase 2). Stop once Phase 1 is
   working and tested, and give me a summary of what you built and how you
   verified it.

## Non-goals for this phase
- No GitHub API calls, no Octokit, no `.github/workflows/` files.
- No leaderboard, no PR logic, no follow-up/"receipts" quoting mechanic —
  that's Phase 3.
- No database, no hosting.
```

Once Phase 1 is working and merged, come back for a Phase 2 prompt (the PR-time GitHub Action) and later a Phase 3 prompt (the follow-up mechanic) — feed them one at a time rather than all at once.