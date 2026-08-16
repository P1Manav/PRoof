/**
 * action/lib/github.js
 *
 * Thin, testable wrappers around Octokit for the Receipts Action.
 */

/** Unique marker embedded in every bot comment so we can find and update it. */
export const RECEIPTS_MARKER = '<!-- proof-bot-v1 -->';

/**
 * Find an existing Receipts bot comment on a PR.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, prNumber: number }} opts
 * @returns {Promise<{ id: number }|null>}
 */
export async function findBotComment(octokit, { owner, repo, prNumber }) {
  // Paginate through all comments looking for our marker
  for await (const { data: comments } of octokit.paginate.iterator(
    octokit.rest.issues.listComments,
    { owner, repo, issue_number: prNumber, per_page: 50 }
  )) {
    for (const comment of comments) {
      if (comment.body?.includes(RECEIPTS_MARKER)) {
        return { id: comment.id };
      }
    }
  }
  return null;
}

/**
 * Create or update the Receipts bot comment on a PR.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, prNumber: number, body: string }} opts
 * @returns {Promise<number>} comment id
 */
export async function upsertComment(octokit, { owner, repo, prNumber, body }) {
  const existing = await findBotComment(octokit, { owner, repo, prNumber });

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return existing.id;
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

/**
 * Get the list of commits in a PR (full SHAs).
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, prNumber: number }} opts
 * @returns {Promise<string[]>}
 */
export async function getPrCommitShas(octokit, { owner, repo, prNumber }) {
  const shas = [];
  for await (const { data: commits } of octokit.paginate.iterator(
    octokit.rest.pulls.listCommits,
    { owner, repo, pull_number: prNumber, per_page: 100 }
  )) {
    for (const c of commits) shas.push(c.sha);
  }
  return shas;
}

/**
 * Get the diff stat text for a PR (files changed summary).
 * Uses the compare API between base and head.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, base: string, head: string }} opts
 * @returns {Promise<string>}
 */
export async function getPrDiffStat(octokit, { owner, repo, base, head }) {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });

  // Produce a simple "filename changed" text — enough for the heuristic
  return data.files?.map((f) => `${f.filename} ${f.status}`).join('\n') ?? '';
}

/**
 * Append a line to the JSONL audit log on the `receipts-data` branch.
 * Creates the file/branch if they don't exist yet.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, record: object }} opts
 */
export async function appendAuditLog(octokit, { owner, repo, record }) {
  const branch = 'receipts-data';
  const path   = '.receipts/log.jsonl';
  const line   = JSON.stringify(record) + '\n';

  // Try to read the existing file
  let existingContent = '';
  let existingSha;

  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(data) && data.content) {
      existingContent = Buffer.from(data.content, 'base64').toString('utf8');
      existingSha = data.sha;
    }
  } catch (err) {
    if (err.status !== 404) throw err;
    // File or branch doesn't exist yet — handled below
  }

  const newContent = Buffer.from(existingContent + line).toString('base64');

  // Ensure the receipts-data branch exists
  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch });
  } catch (err) {
    if (err.status === 404) {
      // Create branch from default branch HEAD
      const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
      const { data: ref } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${repoData.default_branch}`,
      });
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      });
    } else {
      throw err;
    }
  }

  // Commit the updated file
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message: `chore: receipts audit log — PR #${record.pr}`,
    content: newContent,
    ...(existingSha ? { sha: existingSha } : {}),
  });
}
