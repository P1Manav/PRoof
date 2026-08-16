/**
 * action/pr-audit.js
 *
 * GitHub Actions entry point for the PR audit.
 * Runs inside receipts-pr.yml on pull_request [opened, synchronize].
 *
 * Reads:
 *  - Git notes for every commit in the PR (refs/notes/receipts)
 *  - PR body from the GitHub event payload
 *  - Diff stat via Octokit
 *  - README staleness via git log
 *
 * Posts or updates one bot comment on the PR.
 */

import * as core   from '@actions/core';
import * as github from '@actions/github';

import { getNotesForShas, minConfidence }         from './lib/notes.js';
import { checkDescriptionVsDiff, readmeStaleDays, confidenceEmoji } from './lib/heuristics.js';
import { getPrCommitShas, getPrDiffStat, upsertComment, appendAuditLog, RECEIPTS_MARKER } from './lib/github.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function confBar(score, outOf = 10) {
  if (score === null) return 'n/a';
  return `${score}/${outOf} ${'█'.repeat(score)}${'░'.repeat(outOf - score)}`;
}

function formatComment({ prNumber, minConf, descFlag, stalenessDays, notes }) {
  const emoji = confidenceEmoji(minConf);
  const descStatus = descFlag
    ? '⚠️  Low overlap between PR description and changed files — description may not match the diff.'
    : '✅  PR description appears to cover the changed areas.';

  const readmeStatus = stalenessDays >= 14
    ? `⚠️  README last updated **${stalenessDays} days ago** — consider updating docs.`
    : stalenessDays >= 7
    ? `ℹ️  README last updated ${stalenessDays} days ago.`
    : `✅  README is recent (${stalenessDays} days ago).`;

  const notesList = notes.length
    ? notes
        .map((n) => `- \`${n.sha.slice(0, 7)}\`  **${n.confidence}/10**  _${n.author}_ @ ${n.timestamp}`)
        .join('\n')
    : '_No confidence scores recorded for commits in this PR._\n_(Install the hook: `bash install.sh`.)_';

  return `<!-- proof-bot-v1 -->
## 🧾 PRoof — PR Audit

${emoji} **Lowest confidence score in this PR: ${minConf !== null ? `${minConf}/10  ${confBar(minConf)}` : 'no scores recorded'}**

---

### Confidence scores per commit

${notesList}

---

### Description vs diff

${descStatus}

---

### Documentation freshness

${readmeStatus}

---

<sub>PRoof bot • [What is this?](https://github.com/your-org/PRoof#readme)</sub>
`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  try {
    const token   = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);

    const ctx      = github.context;
    const { owner, repo } = ctx.repo;
    const pr       = ctx.payload.pull_request;
    const prNumber = pr.number;

    core.info(`Auditing PR #${prNumber} in ${owner}/${repo}`);

    // 1. Get commit SHAs for this PR
    const shas = await getPrCommitShas(octokit, { owner, repo, prNumber });
    core.info(`Found ${shas.length} commits in PR`);

    // 2. Read git notes (fetched in the workflow before this script runs)
    const notes   = getNotesForShas(shas);
    const minConf = minConfidence(notes);
    core.info(`Notes found: ${notes.length}, min confidence: ${minConf}`);

    // 3. Description vs diff heuristic
    const diffStat = await getPrDiffStat(octokit, {
      owner,
      repo,
      base: pr.base.sha,
      head: pr.head.sha,
    });
    const { flagged: descFlag } = checkDescriptionVsDiff(pr.body ?? '', diffStat);

    // 4. README staleness
    const stalenessDays = readmeStaleDays();

    // 5. Post/update the bot comment
    const body      = formatComment({ prNumber, minConf, descFlag, stalenessDays, notes });
    const commentId = await upsertComment(octokit, { owner, repo, prNumber, body });
    core.info(`Comment upserted: id=${commentId}`);

    // 6. Append audit record to the JSONL log on receipts-data branch
    const record = {
      pr:              prNumber,
      sha_range:       shas.length ? [shas[0], shas[shas.length - 1]] : [],
      min_confidence:  minConf,
      desc_flag:       descFlag,
      readme_stale_days: stalenessDays,
      posted_comment_id: commentId,
      created:         new Date().toISOString(),
    };
    await appendAuditLog(octokit, { owner, repo, record });
    core.info('Audit record appended to receipts-data branch.');

  } catch (err) {
    core.setFailed(`Receipts PR audit failed: ${err.message}`);
  }
}

run();
