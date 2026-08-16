#!/usr/bin/env node
/**
 * hook/log-confidence.js
 *
 * Called by hook/post-commit after every commit.
 * - Skips silently when stdin is not a TTY (scripted / CI commits).
 * - Prompts for a confidence score 1–10, re-prompts once on bad input,
 *   then gives up — never blocks a commit.
 * - Stores the score as a git note in refs/notes/receipts.
 */

import { execSync } from 'child_process';
import * as readline from 'readline';

// ── helpers ──────────────────────────────────────────────────────────────────

function git(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function isValidScore(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10;
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Skip entirely in non-interactive environments (CI, scripted commits).
  if (!process.stdin.isTTY) {
    process.exit(0);
  }

  let sha, author;
  try {
    sha    = git('git rev-parse HEAD');
    author = git('git config user.name');
  } catch {
    // If we can't even get the SHA we're in a weird state — bail silently.
    process.exit(0);
  }

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stderr, // write prompt to stderr so it doesn't pollute stdout
  });

  let score = null;
  const attempts = 2;

  for (let i = 0; i < attempts; i++) {
    const raw = (await prompt(rl, 'Confidence this commit works (1-10): ')).trim();
    if (isValidScore(raw)) {
      score = Number(raw);
      break;
    }
    if (i < attempts - 1) {
      process.stderr.write('  ✗ Enter a whole number between 1 and 10.\n');
    }
  }

  rl.close();

  if (score === null) {
    // Two bad attempts — skip logging, don't block commit.
    process.stderr.write('  Receipts: skipping log (invalid input).\n');
    process.exit(0);
  }

  const note = JSON.stringify({
    sha,
    confidence: score,
    timestamp:  new Date().toISOString(),
    author,
  });

  try {
    // -f overwrites any existing note for this SHA (e.g. amended commits).
    git(`git notes --ref=receipts add -f -m '${note}' ${sha}`);
    process.stderr.write(`  Receipts: logged confidence ${score}/10.\n`);
  } catch (err) {
    // Writing the note failed — skip silently.
    process.stderr.write(`  Receipts: could not write note (${err.message}).\n`);
  }
}

main().catch(() => process.exit(0));
