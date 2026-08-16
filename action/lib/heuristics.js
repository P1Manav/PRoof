/**
 * action/lib/heuristics.js
 *
 * Lightweight heuristics for the PR audit comment.
 * Deliberately avoids an LLM call — v1 uses word-overlap + git log.
 * Replace with Claude API in v2.
 */

import { execSync } from 'child_process';

// ── Description vs diff heuristic ────────────────────────────────────────────

/**
 * Tokenise text into lowercase words (letters + digits only).
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  return new Set((text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Common English stop words to ignore in overlap scoring. */
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','this','that','these',
  'those','it','its','we','i','you','he','she','they','them','their','our',
  'my','your','his','her','fix','fixes','fixed','add','adds','added','update',
  'updates','updated','change','changes','changed','remove','removes','removed',
]);

/**
 * Returns true (flag = mismatch detected) when the PR description shares
 * very few content words with the diff stat summary.
 *
 * @param {string} prBody        Full PR body text
 * @param {string} diffStatText  Output of `git diff --stat` or similar
 * @returns {{ flagged: boolean, overlapRatio: number }}
 */
export function checkDescriptionVsDiff(prBody, diffStatText) {
  const descWords = tokenize(prBody);
  const diffWords = tokenize(diffStatText);

  // Remove stop words
  for (const w of STOP_WORDS) {
    descWords.delete(w);
    diffWords.delete(w);
  }

  // Empty description → always flag
  if (descWords.size === 0) return { flagged: true, overlapRatio: 0 };
  if (diffWords.size  === 0) return { flagged: false, overlapRatio: 1 };

  const intersection = [...descWords].filter((w) => diffWords.has(w));
  const overlapRatio = intersection.length / Math.min(descWords.size, diffWords.size);

  // Flag when fewer than 10% of meaningful words match
  return { flagged: overlapRatio < 0.10, overlapRatio };
}

// ── README staleness ──────────────────────────────────────────────────────────

/**
 * Returns the number of days since the last commit that touched README.md
 * (or README, README.rst, etc.) in the current working directory.
 *
 * @returns {number}  Days since last README commit; 0 if README was just touched.
 */
export function readmeStaleDays() {
  try {
    const lastCommitDate = execSync(
      'git log -1 --format=%ci -- README.md README.rst README.txt README',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!lastCommitDate) {
      // README has never been committed — very stale
      return 9999;
    }

    const diffMs = Date.now() - new Date(lastCommitDate).getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

// ── Confidence score comment fragment ─────────────────────────────────────────

/**
 * Returns a confidence colour emoji based on score.
 * @param {number|null} score
 */
export function confidenceEmoji(score) {
  if (score === null) return '⬜';
  if (score >= 8)     return '🟢';
  if (score >= 5)     return '🟡';
  return '🔴';
}
