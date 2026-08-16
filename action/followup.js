/**
 * action/followup.js
 *
 * GitHub Actions entry point for the Receipts follow-up mechanic.
 * Runs inside receipts-followup.yml on:
 *   - workflow_run [completed]   — CI finished (passed or failed)
 *   - pull_request [closed]      — PR merged or closed without merge (revert signal)
 *
 * Behaviour:
 *   - Looks up the PR number from the event payload.
 *   - Reads .receipts/log.jsonl from the receipts-data branch.
 *   - Finds the audit record for this PR.
 *   - Determines outcome: CI failed, PR reverted (closed without merge), or passed.
 *   - If outcome is noteworthy (failure or revert), posts a follow-up comment quoting
 *     the original confidence claim.
 *   - If outcome is a clean pass and confidence was low (≤ 4), posts a positive receipt.
 */

import * as core   from '@actions/core';
import * as github from '@actions/github';

import { RECEIPTS_MARKER } from './lib/github.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Read and parse the JSONL audit log from the receipts-data branch.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string }} opts
 * @returns {Promise<object[]>}
 */
async function readAuditLog(octokit, { owner, repo }) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.receipts/log.jsonl',
      ref:  'receipts-data',
    });

    if (Array.isArray(data) || !data.content) return [];
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/**
 * Determine the PR number from the event context.
 * workflow_run gives us the triggering workflow's head SHA; we resolve via pulls API.
 * pull_request events have pr.number directly.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} ctx  github.context
 * @returns {Promise<number|null>}
 */
async function resolvePrNumber(octokit, ctx) {
  const { owner, repo } = ctx.repo;

  if (ctx.eventName === 'pull_request') {
    return ctx.payload.pull_request?.number ?? null;
  }

  if (ctx.eventName === 'workflow_run') {
    const run = ctx.payload.workflow_run;
    if (!run) return null;

    // workflow_run may carry pull_requests[] directly
    if (run.pull_requests?.length) {
      return run.pull_requests[0].number;
    }

    // Otherwise: search open/closed PRs matching the head SHA
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      head:  `${owner}:${run.head_branch}`,
      per_page: 5,
    });

    return prs[0]?.number ?? null;
  }

  return null;
}

/**
 * Determine outcome for posting a follow-up.
 *
 * @param {object} ctx
 * @returns {{ type: 'ci_failure'|'revert'|'ci_success'|'merged'|'unknown', detail: string }}
 */
function determineOutcome(ctx) {
  if (ctx.eventName === 'workflow_run') {
    const run = ctx.payload.workflow_run;
    if (run?.conclusion === 'failure') return { type: 'ci_failure', detail: run.name };
    if (run?.conclusion === 'success') return { type: 'ci_success', detail: run.name };
    return { type: 'unknown', detail: run?.conclusion ?? 'unknown' };
  }

  if (ctx.eventName === 'pull_request') {
    const pr = ctx.payload.pull_request;
    if (!pr?.merged) return { type: 'revert', detail: 'closed without merge' };
    return { type: 'merged', detail: 'merged' };
  }

  return { type: 'unknown', detail: 'unknown event' };
}

/**
 * Build the follow-up comment body.
 */
function buildFollowUpComment({ record, outcome, prNumber }) {
  const conf  = record.min_confidence;
  const range = record.sha_range?.map((s) => `\`${s.slice(0, 7)}\``).join('…') ?? 'n/a';
  const ts    = record.created ? new Date(record.created).toUTCString() : '—';

  const outcomeLines = {
    ci_failure: `🔴 **CI failed** on this PR (workflow: _${outcome.detail}_).`,
    revert:     `🔴 **PR was closed without merging** — possibly reverted or abandoned.`,
    ci_success: `🟢 **CI passed!** Low confidence, but it shipped clean — nice one.`,
    merged:     `✅ **PR merged.** Confidence ${conf}/10 and it landed — receipt filed.`,
    unknown:    `ℹ️  Outcome: _${outcome.detail}_.`,
  };

  const shouldPost =
    outcome.type === 'ci_failure' ||
    outcome.type === 'revert'     ||
    (outcome.type === 'ci_success' && conf !== null && conf <= 4) ||
    (outcome.type === 'merged'     && conf !== null && conf <= 4);

  if (!shouldPost) return null;

  return `<!-- proof-followup-v1 -->
## 🧾 PRoof — Follow-up

${outcomeLines[outcome.type]}

> At audit time (**${ts}**), the lowest confidence score in this PR (commits ${range}) was recorded as **${conf !== null ? `${conf}/10` : 'not recorded'}**.

${
  conf !== null && conf <= 4 && (outcome.type === 'ci_failure' || outcome.type === 'revert')
    ? `> You had doubts — and the outcome confirmed them. That's the receipt.`
    : conf !== null && conf >= 8 && outcome.type === 'ci_failure'
    ? `> You were confident (${conf}/10) — but CI didn't agree. That's the receipt.`
    : ''
}

---

<sub>PRoof bot • [What is this?](https://github.com/your-org/PRoof#readme)</sub>
`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  try {
    const token   = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);
    const ctx     = github.context;
    const { owner, repo } = ctx.repo;

    core.info(`Follow-up triggered by: ${ctx.eventName}`);

    // 1. Resolve PR number
    const prNumber = await resolvePrNumber(octokit, ctx);
    if (!prNumber) {
      core.info('Could not resolve a PR number from this event — skipping.');
      return;
    }
    core.info(`Resolved PR #${prNumber}`);

    // 2. Read audit log
    const log    = await readAuditLog(octokit, { owner, repo });
    const record = log.find((r) => r.pr === prNumber);

    if (!record) {
      core.info(`No audit record found for PR #${prNumber} — skipping.`);
      return;
    }
    core.info(`Found audit record: min_confidence=${record.min_confidence}`);

    // 3. Determine outcome
    const outcome = determineOutcome(ctx);
    core.info(`Outcome: ${outcome.type} (${outcome.detail})`);

    // 4. Build and post follow-up comment (if warranted)
    const body = buildFollowUpComment({ record, outcome, prNumber });

    if (!body) {
      core.info('No noteworthy outcome for this PR — no follow-up comment needed.');
      return;
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    core.info(`Follow-up receipt posted on PR #${prNumber}.`);

  } catch (err) {
    core.setFailed(`Receipts follow-up failed: ${err.message}`);
  }
}

run();
