# PRoof — Developer Confidence Tracking for GitHub PRs

PRoof is a GitHub App that lives on your repository and holds contributors accountable for the confidence they claim on each pull request. It asks for a score when a PR is opened and follows up with a receipt if CI fails or the PR is closed without merging.

---

## How it works

```
PR opened
  → PRoof posts a comment: "Reply with your confidence (1-10) this PR is correct."

Contributor replies "8"
  → PRoof adds a 👍 reaction to confirm the score was logged
  → Score stored, scoped to this repo + PR

New commits pushed to the PR
  → PRoof edits its original comment to ask again (no duplicate spam)

CI fails OR PR closed unmerged
  → PRoof posts a follow-up receipt:
    "@user logged 8/10 confidence, but CI just failed. 🚨"

PR merged successfully
  → Score marked SUCCESS in the database — no follow-up needed
```

No dashboard. No cross-repo visibility. Each repo's data stays in its own PR threads.

---

## Install the GitHub App

1. Go to the [PRoof GitHub App page](https://github.com/apps/pr-o0of)
2. Click **Install** and select the repositories you want PRoof to monitor
3. That's it — PRoof will automatically start commenting on new PRs

### Required permissions

| Permission | Level |
|---|---|
| Contents | Read |
| Pull requests | Read & write |
| Checks | Read |
| Metadata | Read |

### Subscribed events

`pull_request`, `issue_comment`, `check_run`, `installation`

---

## Optional: Local git hook (per-commit confidence)

The local hook captures confidence at commit time, giving finer-grained data per commit SHA rather than per PR. It is **not required** — the comment-based flow above works for everyone without any local setup.

To install the hook into a repo:

```bash
bash install.sh /path/to/your/repo
```

After installation, when you `git commit`, you'll be prompted:

```
Confidence this commit works (1-10, or Enter to skip):
```

The score is stored as a git note (`git notes --ref=receipts`) and submitted to PRoof's backend automatically.

If a PR has both a git-note score and a comment-reply score, the comment-reply score is used as the authoritative value (it's the one guaranteed to exist for all contributors, including third-party repo users who haven't installed the hook).

---

## Confidence scoring

| Score | Meaning |
|---|---|
| 1–3 🔴 | Low — significant uncertainty |
| 4–6 🟡 | Medium — fairly confident, some unknowns |
| 7–9 🟢 | High — confident this is correct |
| 10 ✅ | Certain — fully reviewed and tested |

Accepted reply formats: `8`, `8/10`, `confidence: 8`, `confidence:8`

---

## Environment variables (for self-hosters)

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `GITHUB_APP_ID` | Your GitHub App's numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Full contents of the `.pem` private key file |
| `GITHUB_WEBHOOK_SECRET` | Secret used to verify incoming webhook signatures |
| `GEMINI_API_KEY` | (Optional) Enables AI-powered PR description quality judgment |

> **Note on `GITHUB_APP_PRIVATE_KEY`**: If your hosting provider mangles newlines in multiline env vars, replace them with literal `\n` — PRoof normalizes them on startup.

### Local development

```bash
# Copy and fill in the template
cp .env.example .env

# Run migrations
npx prisma migrate dev

# Start the dev server
npm run dev
```

For local dev, you can set `GITHUB_TOKEN` (a PAT) instead of the App credentials. The App auth path is only activated when `GITHUB_APP_ID` is present.

---

## Webhook URL

```
https://<your-deployment>.vercel.app/api/webhooks/github
```

---

## Tech stack

- **Next.js** (App Router, Route Handlers)
- **Prisma ORM** + **Prisma Postgres** (managed PostgreSQL)
- **@octokit/auth-app** — GitHub App installation auth
- **Google Gemini** — optional PR description quality judgment
- **Vercel** — deployment
