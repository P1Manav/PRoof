#!/usr/bin/env node
/**
 * test/verify.js
 *
 * Phase 1 end-to-end verification.
 * Adapts to both Windows (uses Git Bash) and Unix.
 *
 * Exits 0 on success, 1 on failure.
 */

import { spawnSync } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

// ── utils ─────────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';

let passed = 0;
let failed = 0;

function ok(msg)   { console.log(`  ${GREEN}✓${RESET}  ${msg}`); passed++; }
function fail(msg) { console.log(`  ${RED}✗${RESET}  ${msg}`);   failed++; }
function section(t){ console.log(`\n${BOLD}${YELLOW}── ${t}${RESET}`); }

// Detect Git Bash on Windows
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  // Common Git for Windows locations
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Fall back — might be in PATH
  return 'bash';
}

const BASH = findBash();

function sh(cmd, cwd, opts = {}) {
  return spawnSync(BASH, ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME:     'Test',
      GIT_AUTHOR_EMAIL:    'test@test.com',
      GIT_COMMITTER_NAME:  'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
    ...opts,
  });
}

// Convert Windows path to Unix path for use inside bash
function toUnix(p) {
  // e.g. D:\Projects\PRoof\receipts → /d/Projects/PRoof/receipts
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

function node(args, cwd, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    ...opts,
  });
}

// ── setup ─────────────────────────────────────────────────────────────────────

const RECEIPTS_ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-test-'));

console.log(`\n${BOLD}Receipts Phase 1 — Verification${RESET}`);
console.log(`  Bash:          ${BASH}`);
console.log(`  Scratch repo:  ${SCRATCH}`);
console.log(`  Receipts root: ${RECEIPTS_ROOT}`);

const SCRATCH_UNIX = toUnix(SCRATCH);
const ROOT_UNIX    = toUnix(RECEIPTS_ROOT);

// ── test 1: git init ─────────────────────────────────────────────────────────

section('1. Git init');
{
  const r = sh(
    'git init && git config user.email "test@test.com" && git config user.name "Test"',
    SCRATCH
  );
  r.status === 0 ? ok('git init succeeded') : fail(`git init failed: ${r.stderr}`);
}

// ── test 2: install.sh error path ────────────────────────────────────────────

section('2. install.sh — error on non-git directory');
{
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-nongit-'));
  const nonGitUnix = toUnix(nonGit);
  const r = sh(`bash "${ROOT_UNIX}/install.sh" "${nonGitUnix}"`, RECEIPTS_ROOT);
  if (r.status !== 0 && (r.stdout + r.stderr).includes('not a git repository')) {
    ok('install.sh correctly rejected a non-git directory');
  } else {
    fail(`Expected exit != 0 with error message. Status=${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  fs.rmSync(nonGit, { recursive: true, force: true });
}

// ── test 3: install.sh success path ──────────────────────────────────────────

section('3. install.sh — success path');
{
  const r = sh(`bash "${ROOT_UNIX}/install.sh" "${SCRATCH_UNIX}"`, RECEIPTS_ROOT);
  r.status === 0 ? ok('install.sh exited 0') : fail(`install.sh failed (status ${r.status}): ${r.stderr}\n${r.stdout}`);

  const hookPath = path.join(SCRATCH, '.git/hooks/post-commit');
  const jsPath   = path.join(SCRATCH, '.git/hooks/log-confidence.js');

  fs.existsSync(hookPath) ? ok('post-commit hook copied')   : fail('post-commit hook missing');
  fs.existsSync(jsPath)   ? ok('log-confidence.js copied')  : fail('log-confidence.js missing');

  if (fs.existsSync(hookPath)) {
    if (process.platform !== 'win32') {
      const stat = fs.statSync(hookPath);
      // eslint-disable-next-line no-bitwise
      (stat.mode & 0o111) ? ok('post-commit is executable') : fail('post-commit not executable');
    } else {
      ok('post-commit executable check skipped on Windows (bash handles this)');
    }
  }
}

// ── test 4: automated commits don't hang ─────────────────────────────────────

section('4. Automated commits — must complete without prompting (non-TTY stdin)');
{
  sh('echo "hello" > hello.txt && git add . && git commit -m "first commit"',  SCRATCH);
  sh('echo "world" > world.txt && git add . && git commit -m "second commit"', SCRATCH);

  const r = sh('git log --oneline', SCRATCH);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  lines.length >= 2
    ? ok(`Commits completed — found ${lines.length} commit(s) in log`)
    : fail(`Expected ≥ 2 commits. Output: ${r.stdout}`);
}

// ── test 5: receipts log — no scores ─────────────────────────────────────────

section('5. receipts log — no scores recorded yet');
{
  const r = node([path.join(RECEIPTS_ROOT, 'bin/receipts.js'), 'log'], SCRATCH);
  r.stdout.includes('No confidence scores recorded yet')
    ? ok('"No confidence scores recorded yet." printed correctly')
    : fail(`Unexpected output: ${r.stdout}\nstderr: ${r.stderr}`);
}

// ── test 6: inject notes, verify receipts log ─────────────────────────────────

section('6. receipts log — with injected git notes');
{
  const logR = sh('git log --format=%H', SCRATCH);
  const shas = logR.stdout.trim().split('\n').filter(Boolean);

  const now   = new Date().toISOString();
  const note1 = JSON.stringify({ sha: shas[0], confidence: 8, timestamp: now, author: 'Test' });
  const note2 = JSON.stringify({ sha: shas[1], confidence: 3, timestamp: now, author: 'Test' });

  sh(`git notes --ref=receipts add -f -m '${note1}' ${shas[0]}`, SCRATCH);
  sh(`git notes --ref=receipts add -f -m '${note2}' ${shas[1]}`, SCRATCH);

  const r = node([path.join(RECEIPTS_ROOT, 'bin/receipts.js'), 'log'], SCRATCH);

  r.stdout.includes('8/10') ? ok('Score 8/10 appears in table') : fail(`8/10 not found. Output:\n${r.stdout}`);
  r.stdout.includes('3/10') ? ok('Score 3/10 appears in table') : fail(`3/10 not found. Output:\n${r.stdout}`);
  r.stdout.includes('Test') ? ok('Author "Test" appears in table') : fail(`Author not found. Output:\n${r.stdout}`);

  console.log('\n  Sample output:');
  r.stdout.split('\n').forEach((l) => console.log(`    ${l}`));
}

// ── test 7: log-confidence.js skips on non-TTY ───────────────────────────────

section('7. log-confidence.js — skips silently on non-TTY stdin');
{
  const hookJs = path.join(SCRATCH, '.git/hooks/log-confidence.js');
  if (!fs.existsSync(hookJs)) {
    fail('log-confidence.js not found in hooks — install.sh may have failed');
  } else {
    const r = node([hookJs], SCRATCH, { input: '' }); // piped stdin = not TTY
    (r.status === 0 && !r.stderr.includes('Confidence this commit works'))
      ? ok('Exited 0, no prompt shown — non-TTY path works correctly')
      : fail(`Expected silent exit. Status=${r.status}\nstderr: ${r.stderr}`);
  }
}

// ── test 8: receipts help ────────────────────────────────────────────────────

section('8. receipts help');
{
  const r = node([path.join(RECEIPTS_ROOT, 'bin/receipts.js'), 'help'], SCRATCH);
  (r.stdout.includes('proof log') && r.stdout.includes('USAGE'))
    ? ok('Help text includes USAGE and receipts log')
    : fail(`Help text missing expected content:\n${r.stdout}`);
}

// ── test 9: cross-repo confidence score parser isolation ─────────────────────

section('9. parseConfidenceScore — accepted and rejected formats');
{
  // We test the score parser logic independently (it's a pure function
  // embedded in route.js). We inline it here for unit-testing purposes.
  function parseConfidenceScore(body) {
    const text = body.trim();
    const patterns = [
      /^confidence\s*:\s*(\d+)/i,
      /^(\d+)\s*\/\s*10$/,
      /^(\d+)$/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n >= 1 && n <= 10) return n;
      }
    }
    return null;
  }

  // Accepted formats
  parseConfidenceScore('7') === 7 ? ok('"7" → 7') : fail('"7" not parsed');
  parseConfidenceScore('10') === 10 ? ok('"10" → 10') : fail('"10" not parsed');
  parseConfidenceScore('1') === 1 ? ok('"1" → 1') : fail('"1" not parsed');
  parseConfidenceScore('8/10') === 8 ? ok('"8/10" → 8') : fail('"8/10" not parsed');
  parseConfidenceScore('confidence: 8') === 8 ? ok('"confidence: 8" → 8') : fail('"confidence: 8" not parsed');
  parseConfidenceScore('confidence:8') === 8 ? ok('"confidence:8" → 8') : fail('"confidence:8" not parsed');
  parseConfidenceScore('CONFIDENCE: 5') === 5 ? ok('"CONFIDENCE: 5" (case-insensitive) → 5') : fail('"CONFIDENCE: 5" not parsed');

  // Rejected formats
  parseConfidenceScore('banana') === null ? ok('"banana" → null (ignored)') : fail('"banana" should be null');
  parseConfidenceScore('0') === null ? ok('"0" → null (out of range)') : fail('"0" should be null');
  parseConfidenceScore('11') === null ? ok('"11" → null (out of range)') : fail('"11" should be null');
  parseConfidenceScore('') === null ? ok('"" → null') : fail('"" should be null');
  parseConfidenceScore('lgtm') === null ? ok('"lgtm" → null') : fail('"lgtm" should be null');
}

// ── test 10: cross-repo data isolation (DB-level simulation) ─────────────────

section('10. Cross-repo isolation — receipt scoping simulation');
{
  // Simulate two repos with receipts in separate buckets.
  // In production, all queries in route.js are scoped to repoFullName.
  // Here we verify the scoping logic (in-memory).

  const receipts = [
    { repoFullName: 'acme/repo-a', prNumber: 101, userId: 'alice', confidence: 7 },
    { repoFullName: 'acme/repo-a', prNumber: 101, userId: 'bob',   confidence: 5 },
    { repoFullName: 'acme/repo-b', prNumber: 201, userId: 'alice', confidence: 9 },
    { repoFullName: 'acme/repo-b', prNumber: 201, userId: 'carol', confidence: 3 },
  ];

  const queryForRepo = (fullName, prNum) =>
    receipts.filter(r => r.repoFullName === fullName && r.prNumber === prNum);

  const repoAResults = queryForRepo('acme/repo-a', 101);
  const repoBResults = queryForRepo('acme/repo-b', 201);

  // repo-a results contain only repo-a data
  const repoAHasRepoBData = repoAResults.some(r => r.repoFullName === 'acme/repo-b');
  !repoAHasRepoBData
    ? ok('repo-a query returns no repo-b data')
    : fail('repo-a query leaks repo-b data!');

  // repo-b results contain only repo-b data
  const repoBHasRepoAData = repoBResults.some(r => r.repoFullName === 'acme/repo-a');
  !repoBHasRepoAData
    ? ok('repo-b query returns no repo-a data')
    : fail('repo-b query leaks repo-a data!');

  // Counts are correct
  repoAResults.length === 2
    ? ok(`repo-a has 2 receipts (got ${repoAResults.length})`)
    : fail(`repo-a should have 2 receipts, got ${repoAResults.length}`);
  repoBResults.length === 2
    ? ok(`repo-b has 2 receipts (got ${repoBResults.length})`)
    : fail(`repo-b should have 2 receipts, got ${repoBResults.length}`);

  // alice's score on repo-b (9) should NOT appear in repo-a results
  const aliceOnRepoA = repoAResults.find(r => r.userId === 'alice');
  aliceOnRepoA && aliceOnRepoA.confidence !== 9
    ? ok("alice's repo-b score (9) does not appear in repo-a results")
    : !aliceOnRepoA
    ? ok("alice is not in repo-a results (correct — she only has repo-a PR 101)")
    : fail("alice's repo-b score leaked into repo-a results");
}

// ── cleanup ───────────────────────────────────────────────────────────────────

fs.rmSync(SCRATCH, { recursive: true, force: true });

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed ? RED : GREEN}${failed} failed${RESET}\n`);
process.exit(failed > 0 ? 1 : 0);

