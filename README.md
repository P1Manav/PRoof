# 🧾 PRoof

> A developer accountability tool that logs your commit-time confidence scores and quotes them back at you when your code breaks.

**Core loop:**  
`git commit` → prompted for a confidence score (1–10) → score stored in git notes → PR opened → bot audits description, docs, and confidence in one comment → CI fails or PR gets reverted → bot posts a follow-up quoting your original claim, timestamped.

---

## How it works

### 1. Local hook — log your confidence

After every commit, a post-commit hook prompts:

```
Confidence this commit works (1-10): _
```

Your score (plus commit SHA, timestamp, and author) is stored as a `git note` in the `refs/notes/receipts` namespace. No database, no network call at commit time.

### 2. PR audit — one bot comment per PR

When you open or push to a PR, a GitHub Action posts a single comment covering:

- **Lowest confidence score** across all commits in the PR
- **Description vs diff** — flags if the PR description shares few words with the changed files
- **README freshness** — warns if docs haven't been touched in ≥ 14 days

The comment is updated (not re-posted) on subsequent pushes.

### 3. Follow-up receipts — your claims come back to haunt you

When CI fails or a PR is closed without merging, the bot posts a follow-up comment quoting your original confidence claim and the outcome. Low confidence + failure = receipt filed. High confidence + failure = also a receipt. Low confidence + clean pass = deserved kudos.

---

## Install the hook

### Prerequisites

- Node.js 20+
- A git repo (obviously)
- GitHub CLI (`gh`), authenticated — for pushing notes

### Steps

```bash
# 1. Clone this repo
git clone https://github.com/your-org/PRoof.git
cd PRoof

# 2. Install dependencies
npm install

# 3. Install the hook into any target repo
bash install.sh /path/to/your-target-repo
```

`install.sh` copies `hook/post-commit` and `hook/log-confidence.js` into your repo's `.git/hooks/` and makes the hook executable. It also configures git to push notes to `origin` automatically.

### Push notes to GitHub

By default git does not push notes. Either push explicitly:

```bash
git push origin refs/notes/receipts
```

Or rely on the auto-configured refspec added by `install.sh`:

```bash
git push  # notes go with it automatically
```

---

## CLI — `proof log`

```bash
# From inside any repo where the hook is installed:
proof log
```

Sample output:

```
COMMIT   CONFIDENCE                    AUTHOR                WHEN
─────────────────────────────────────────────────────────────────
a1b2c3d  8/10 ████████░░              manav                 2 days ago
f4e5d6c  5/10 █████░░░░░              manav                 4 days ago
9a8b7c6  3/10 ███░░░░░░░              manav                 1 week ago
```

---

## Set up the GitHub Actions

1. **Copy `.github/workflows/`** from this repo into your target repo (or push this whole repo to GitHub and use it directly).

2. **Update the CI workflow name** in `receipts-followup.yml`:
   ```yaml
   workflow_run:
     workflows: ['CI']   # ← change to your actual CI workflow name
   ```

3. **Grant permissions** — the workflows already declare the minimum:
   - `contents: read`
   - `pull-requests: write`
   - `issues: write`

4. **Push your notes** after each commit so the Action can read them:
   ```bash
   git push origin refs/notes/receipts
   ```

---

## Data model

**Git note** (one per commit, namespace `refs/notes/receipts`):
```json
{"sha": "abc1234", "confidence": 8, "timestamp": "2026-08-13T10:00:00Z", "author": "manav"}
```

**`.receipts/log.jsonl`** (append-only, on the `receipts-data` branch):
```json
{"pr": 42, "sha_range": ["abc1234","def5678"], "min_confidence": 5, "desc_flag": false, "readme_stale_days": 3, "posted_comment_id": 987654, "created": "2026-08-13T10:05:00Z"}
```

---

## Repo structure

```
receipts/
├── hook/
│   ├── post-commit          # bash wrapper
│   └── log-confidence.js    # prompts confidence, writes git note
├── bin/
│   └── receipts.js          # CLI: receipts log
├── .github/workflows/
│   ├── receipts-pr.yml      # PR audit
│   └── receipts-followup.yml# follow-up receipts
├── action/
│   ├── pr-audit.js          # Action: PR comment
│   ├── followup.js          # Action: follow-up comment
│   └── lib/
│       ├── notes.js         # git notes reader
│       ├── heuristics.js    # description + README checks
│       └── github.js        # Octokit helpers
├── install.sh
├── package.json
├── README.md
```

---

## Roadmap

### v1 (this) — single repo, no backend
- [x] Post-commit confidence logger via git notes
- [x] PR audit Action (confidence + description + README)
- [x] Follow-up receipt Action (CI fail / revert)
- [x] `proof log` CLI

### v2 — installable GitHub App
- [ ] OAuth GitHub App (one-click install for others)
- [ ] Hosted webhook receiver + database
- [ ] Opt-in team leaderboard/dashboard
- [ ] LLM-powered (Claude API) description judgment

> **v2 builds only after v1 has been dogfooded on real repos for 2+ weeks without being disabled.**

---

## License

MIT
