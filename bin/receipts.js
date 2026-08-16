#!/usr/bin/env node
/**
 * bin/receipts.js  —  CLI entry point
 *
 * Usage:
 *   receipts log          Print all confidence scores recorded in the current repo.
 *   receipts help         Show help text.
 */

import { execSync } from 'child_process';

// ── helpers ──────────────────────────────────────────────────────────────────

function git(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

/** Human-readable relative time, e.g. "3 days ago" */
function relativeTime(isoString) {
  const diffMs  = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec <  60)  return `${diffSec} second${diffSec !== 1 ? 's' : ''} ago`;

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60)   return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;

  const diffH = Math.round(diffMin / 60);
  if (diffH   < 24)   return `${diffH} hour${diffH !== 1 ? 's' : ''} ago`;

  const diffD = Math.round(diffH / 24);
  if (diffD   < 30)   return `${diffD} day${diffD !== 1 ? 's' : ''} ago`;

  const diffMo = Math.round(diffD / 30);
  return `${diffMo} month${diffMo !== 1 ? 's' : ''} ago`;
}

/** Pad a string to a fixed width */
function pad(str, width) {
  return String(str).padEnd(width);
}

// ── commands ─────────────────────────────────────────────────────────────────

function cmdLog() {
  // Get all commit SHAs, newest first.
  let allShas;
  try {
    allShas = git('git log --format=%H').split('\n').filter(Boolean);
  } catch {
    console.error('Error: not inside a git repository.');
    process.exit(1);
  }

  if (allShas.length === 0) {
    console.log('No commits found.');
    return;
  }

  const records = [];

  for (const sha of allShas) {
    let raw;
    try {
      raw = git(`git notes --ref=receipts show ${sha}`);
    } catch {
      // No note for this commit — skip it.
      continue;
    }

    try {
      const note = JSON.parse(raw);
      records.push({
        shortSha:   sha.slice(0, 7),
        confidence: note.confidence,
        author:     note.author     ?? '—',
        timestamp:  note.timestamp  ?? null,
      });
    } catch {
      // Malformed note — skip.
    }
  }

  if (records.length === 0) {
    console.log('No confidence scores recorded yet.');
    return;
  }

  // ── table ────────────────────────────────────────────────────────────────
  const COL = { sha: 9, conf: 12, author: 22, when: 20 };
  const divider = '-'.repeat(COL.sha + COL.conf + COL.author + COL.when + 3);

  console.log('');
  console.log(
    pad('COMMIT',     COL.sha)  +
    pad('CONFIDENCE', COL.conf) +
    pad('AUTHOR',     COL.author) +
    'WHEN'
  );
  console.log(divider);

  for (const r of records) {
    const confBar  = `${r.confidence}/10 ${'█'.repeat(r.confidence)}${'░'.repeat(10 - r.confidence)}`;
    const whenStr  = r.timestamp ? relativeTime(r.timestamp) : '—';
    console.log(
      pad(r.shortSha,  COL.sha)  +
      pad(confBar,     COL.conf + 14) + // extra width for bar chars
      pad(r.author,    COL.author) +
      whenStr
    );
  }

  console.log('');
}

function cmdHelp() {
  console.log(`
proof — commit-time confidence tracker (PRoof)

USAGE
  proof log       List all confidence scores in the current repo
  proof help      Show this help

SETUP
  Run install.sh against any git repo to install the post-commit hook.
  After that, every commit will prompt for a score.

DATA
  Scores are stored as git notes under refs/notes/receipts.
  To push them to GitHub:
    git push origin refs/notes/receipts
`);
}

// ── router ────────────────────────────────────────────────────────────────────

const [,, subcommand = 'help'] = process.argv;

switch (subcommand) {
  case 'log':  cmdLog();  break;
  case 'help': cmdHelp(); break;
  default:
    console.error(`Unknown command: ${subcommand}`);
    cmdHelp();
    process.exit(1);
}
