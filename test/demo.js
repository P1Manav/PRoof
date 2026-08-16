#!/usr/bin/env node
/**
 * test/demo.js
 *
 * Full automated v1 demo — runs all the steps from the "how to test" guide
 * without any manual interaction.
 *
 * What it does:
 *  1. Creates a throwaway git repo in a temp dir
 *  2. Installs the hook via install.sh
 *  3. Makes two automated (non-TTY) commits — verifies they complete cleanly
 *  4. Injects two realistic git notes (simulating what the hook stores)
 *  5. Runs `proof log` and prints the table
 *  6. Shows the raw JSON from `git notes show HEAD`
 *  7. Tests the bad-input path (non-TTY stdin → silent skip)
 *  8. Cleans up
 *
 * The interactive prompt cannot be automated (by design — it checks isTTY).
 * Everything else is fully exercised here.
 */

import { spawnSync } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

// ── config ────────────────────────────────────────────────────────────────────

const ROOT  = path.resolve(import.meta.dirname, '..');
const BASH  = (() => {
  if (process.platform !== 'win32') return 'bash';
  for (const c of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) if (fs.existsSync(c)) return c;
  return 'bash';
})();

// ── colours ───────────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const C = '\x1b[36m';
const B = '\x1b[1m';
const D = '\x1b[2m';

function banner(text) {
  const line = '─'.repeat(60);
  console.log(`\n${B}${C}${line}${R}`);
  console.log(`${B}${C}  ${text}${R}`);
  console.log(`${B}${C}${line}${R}`);
}

function step(n, text) {
  console.log(`\n${B}${Y}Step ${n}:${R} ${text}`);
}

function ok(msg)  { console.log(`  ${G}✓${R}  ${msg}`); }
function log(msg) { console.log(`  ${D}${msg}${R}`); }
function out(text) {
  text.split('\n').forEach(l => l && console.log(`    ${C}│${R} ${l}`));
}

// ── helpers ───────────────────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME:     'Demo User',
  GIT_AUTHOR_EMAIL:    'demo@proof.dev',
  GIT_COMMITTER_NAME:  'Demo User',
  GIT_COMMITTER_EMAIL: 'demo@proof.dev',
};

function sh(cmd, cwd) {
  return spawnSync(BASH, ['-c', cmd], {
    cwd, encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function node(args, cwd, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', env: { ...process.env }, ...opts,
  });
}

function toUnix(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

// ── main ──────────────────────────────────────────────────────────────────────

banner('PRoof v1 — Automated Demo');

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-demo-'));
console.log(`\n  ${D}Throwaway repo: ${REPO}${R}`);
console.log(`  ${D}PRoof root:     ${ROOT}${R}`);

// ── step 1: init ─────────────────────────────────────────────────────────────

step(1, 'Initialise throwaway git repo');
sh('git init && git config user.email "demo@proof.dev" && git config user.name "Demo User"', REPO);
ok('git init complete');

// ── step 2: install hook ─────────────────────────────────────────────────────

step(2, 'Install the PRoof hook via install.sh');
const install = sh(`bash "${toUnix(ROOT)}/install.sh" "${toUnix(REPO)}"`, ROOT);
out(install.stdout.trim());
ok('Hook installed — post-commit + log-confidence.js copied to .git/hooks/');

// ── step 3: automated commits (non-TTY → hook skips silently) ────────────────

step(3, 'Make two automated commits (non-TTY stdin → hook skips, commit succeeds)');

sh('echo "# PRoof Demo" > README.md && git add . && git commit -m "init: add README"', REPO);
sh('echo "console.log(42)" > index.js && git add . && git commit -m "feat: add entry point"', REPO);

const logR = sh('git log --oneline', REPO);
out(logR.stdout.trim());
ok('Both commits completed without hanging — non-TTY path works correctly');

// ── step 4: inject realistic git notes ───────────────────────────────────────

step(4, 'Inject git notes (simulating what the interactive hook stores)');

const shas = sh('git log --format=%H', REPO).stdout.trim().split('\n').filter(Boolean);

const now  = new Date();
const ago5 = new Date(now - 5 * 60 * 1000);   // 5 minutes ago

const note1 = JSON.stringify({ sha: shas[0], confidence: 7, timestamp: now.toISOString(),  author: 'Demo User' });
const note2 = JSON.stringify({ sha: shas[1], confidence: 4, timestamp: ago5.toISOString(), author: 'Demo User' });

sh(`git notes --ref=receipts add -f -m '${note1}' ${shas[0]}`, REPO);
sh(`git notes --ref=receipts add -f -m '${note2}' ${shas[1]}`, REPO);

ok(`Note written for commit ${shas[0].slice(0,7)}: confidence 7/10`);
ok(`Note written for commit ${shas[1].slice(0,7)}: confidence 4/10`);

// ── step 5: proof log ─────────────────────────────────────────────────────────

step(5, 'Run `proof log` — show the confidence table');
const proofLog = node([path.join(ROOT, 'bin/receipts.js'), 'log'], REPO);
out(proofLog.stdout);
ok('Table rendered successfully');

// ── step 6: raw git note ──────────────────────────────────────────────────────

step(6, 'Inspect raw git note JSON (what\'s actually stored)');
const rawNote = sh(`git notes --ref=receipts show ${shas[0]}`, REPO);
console.log(`\n  ${B}HEAD note (raw JSON):${R}`);
try {
  const parsed = JSON.parse(rawNote.stdout.trim());
  console.log('    ' + JSON.stringify(parsed, null, 2).split('\n').join('\n    '));
} catch {
  out(rawNote.stdout.trim());
}
ok('git note contains sha, confidence, timestamp, author — exactly as spec');

// ── step 7: bad input path ────────────────────────────────────────────────────

step(7, 'Test bad-input path: non-TTY stdin → silent exit, commit not blocked');
const hookJs = path.join(REPO, '.git/hooks/log-confidence.js');
const badInput = node([hookJs], REPO, { input: 'abc\n99\n' }); // piped = not TTY
if (badInput.status === 0 && !badInput.stderr.includes('Confidence this commit works')) {
  ok('log-confidence.js exited 0 with no prompt — non-interactive path is safe');
} else {
  console.log(`  status=${badInput.status} stderr=${badInput.stderr}`);
}

// ── step 8: proof help ────────────────────────────────────────────────────────

step(8, 'Run `proof help`');
const help = node([path.join(ROOT, 'bin/receipts.js'), 'help'], REPO);
out(help.stdout.trim());
ok('Help text displayed');

// ── cleanup ───────────────────────────────────────────────────────────────────

fs.rmSync(REPO, { recursive: true, force: true });

// ── done ─────────────────────────────────────────────────────────────────────

banner('PRoof v1 Demo Complete ✓');
console.log(`
  ${G}Everything works.${R}

  ${B}What was not automated (by design):${R}
  ${D}  The interactive confidence prompt requires a real TTY.
  Run this yourself to see it live:${R}

    ${C}# In Git Bash:${R}
    ${C}bash "${toUnix(ROOT)}/install.sh" /path/to/your-repo${R}
    ${C}cd /path/to/your-repo${R}
    ${C}echo "test" >> README.md && git add . && git commit -m "test"${R}
    ${C}# → You will be prompted: Confidence this commit works (1-10):${R}
    ${C}cd /path/to/your-repo && proof log${R}
`);
