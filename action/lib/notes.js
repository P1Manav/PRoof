/**
 * action/lib/notes.js
 *
 * Reads git notes from refs/notes/receipts for a list of commit SHAs.
 * Returns an array of parsed note objects; SHAs with no note are skipped.
 *
 * Assumes the caller has already fetched notes in the workflow step:
 *   git fetch origin refs/notes/receipts:refs/notes/receipts
 */

import { execSync } from 'child_process';

/**
 * @param {string} sha
 * @returns {object|null}
 */
export function getNoteForSha(sha) {
  try {
    const raw = execSync(`git notes --ref=receipts show ${sha}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string[]} shas   Full commit SHAs
 * @returns {{ sha: string, confidence: number, timestamp: string, author: string }[]}
 */
export function getNotesForShas(shas) {
  const results = [];
  for (const sha of shas) {
    const note = getNoteForSha(sha);
    if (note && typeof note.confidence === 'number') {
      results.push(note);
    }
  }
  return results;
}

/**
 * Returns the minimum confidence score across the provided notes,
 * or null if there are no notes.
 * @param {object[]} notes
 * @returns {number|null}
 */
export function minConfidence(notes) {
  if (!notes.length) return null;
  return Math.min(...notes.map((n) => n.confidence));
}
