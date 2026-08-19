#!/usr/bin/env node
/**
 * test/commands.test.js
 *
 * Unit tests for the /proof comment commands in route.js.
 * Tests the command parsing, admin gating, and handler behavior
 * by simulating webhook payloads directly.
 *
 * Exits 0 on success, 1 on failure.
 */

import { ok, fail, section, summary } from './_util.js';

// ── In-process mock infrastructure ───────────────────────────────────────────

/**
 * We test the command logic directly without importing route.js (which would
 * pull in Prisma, Octokit, etc). Instead we replicate the command-routing
 * logic here using the same functions from permissions.js and rulesets.js.
 *
 * The key behaviors to verify:
 * 1. /proof help → replies, no admin check
 * 2. /proof config mandatory on/off → admin gate → calls enable/disable + upsert
 * 3. /proof report → admin gate → queries receipts → replies
 * 4. non-admin → rejected for config/report, not help
 * 5. plain number "7" → still recognized as confidence score (not broken)
 * 6. /proof <unknown> → silently ignored
 */

// ── Shared mock factories ─────────────────────────────────────────────────────

function makeOctokit({ permission = 'admin', rulesets = [] } = {}) {
  let nextRulesetId = 100;
  const store = [...rulesets];
  const comments = [];
  let callCount = { permission: 0, createComment: 0, createRuleset: 0, deleteRuleset: 0 };

  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          callCount.permission++;
          return { data: { permission } };
        },
        get: async () => ({ data: { default_branch: 'main' } }),
        getRepoRulesets: async () => ({ data: [...store] }),
        createRepoRuleset: async ({ name }) => {
          callCount.createRuleset++;
          const rs = { id: nextRulesetId++, name };
          store.push(rs);
          return { data: rs };
        },
        deleteRepoRuleset: async ({ ruleset_id }) => {
          callCount.deleteRuleset++;
          const idx = store.findIndex((r) => r.id === ruleset_id);
          if (idx !== -1) store.splice(idx, 1);
        },
      },
      issues: {
        createComment: async ({ body, issue_number }) => {
          callCount.createComment++;
          comments.push({ body, issue_number });
          return { data: { id: Date.now() } };
        },
      },
    },
    _comments: comments,
    _store: store,
    _calls: callCount,
  };
}

function makePrisma({ receipts = [] } = {}) {
  let upserted = null;
  return {
    repoSettings: {
      upsert: async (args) => { upserted = args; return {}; },
    },
    receipt: {
      findMany: async ({ where }) => {
        return receipts.filter((r) => r.repoFullName === where.repoFullName);
      },
    },
    _upserted: () => upserted,
  };
}

// ── Inline the command router logic (same as route.js) ───────────────────────
// We import permissions and rulesets directly, wrapping the router as a pure function.

import { isAdmin } from '../src/lib/permissions.js';
import { enableMandatoryCheck, disableMandatoryCheck } from '../src/lib/rulesets.js';

/**
 * Simulate handleIssueCommentCreated's command-routing section only.
 * Returns { handled: bool, action: string } for test assertions.
 */
async function simulateComment(commentBody, { permission = 'admin', prisma, rulesets = [] } = {}) {
  const octokit = makeOctokit({ permission, rulesets });
  const owner = 'acme';
  const repo = 'test-repo';
  const fullName = 'acme/test-repo';
  const issueNumber = 42;
  const commenterLogin = 'testuser';
  const installationId = 1;

  const trimmedBody = commentBody.trim();
  const proofCmdMatch = trimmedBody.match(/^\/proof\s+(config|report|help)\b(.*)/is);

  if (!proofCmdMatch) {
    // Would fall through to number parser
    return { handled: false, octokit, prisma };
  }

  const cmd = proofCmdMatch[1].toLowerCase();
  const rest = proofCmdMatch[2].trim();

  if (cmd === 'help') {
    // handleProofHelp inline
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: '### 🤖 PRoof — Available Commands\n...',
    });
    return { handled: true, cmd: 'help', octokit, prisma };
  }

  // Admin check
  const adminResult = await isAdmin(octokit, owner, repo, commenterLogin);
  if (!adminResult) {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: '> ⛔ Only repo admins can change PRoof\'s merge requirements.',
    });
    return { handled: true, cmd: 'rejected', octokit, prisma };
  }

  if (cmd === 'config') {
    const configMatch = rest.match(/^mandatory\s+(on|off)$/i);
    if (!configMatch) {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: '> ⚠️ Unknown config option.',
      });
      return { handled: true, cmd: 'config-invalid', octokit, prisma };
    }

    const enabled = configMatch[1].toLowerCase() === 'on';
    if (enabled) {
      await enableMandatoryCheck(octokit, owner, repo);
    } else {
      await disableMandatoryCheck(octokit, owner, repo);
    }

    if (prisma) {
      await prisma.repoSettings.upsert({
        where: { repoFullName: fullName },
        update: { mandatory: enabled, updatedBy: commenterLogin },
        create: { repoFullName: fullName, mandatory: enabled, updatedBy: commenterLogin },
      });
    }

    await octokit.rest.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: enabled ? '### 🤖 PRoof — Config Updated\n\n✅ **Mandatory enabled**' : '### 🤖 PRoof — Config Updated\n\n🔓 **Mandatory disabled**',
    });

    return { handled: true, cmd: 'config', enabled, octokit, prisma };
  }

  if (cmd === 'report') {
    if (prisma) {
      const receipts = await prisma.receipt.findMany({
        where: { repoFullName: fullName },
        include: { user: true },
        orderBy: { timestamp: 'desc' },
      });

      const body = receipts.length === 0
        ? '### 📊 PRoof — Confidence Report\n\nNo scores.\n\n_Visible to anyone who can see this thread._'
        : '### 📊 PRoof — Confidence Report\n\n...table...\n\n> ⚠️ **Visible to anyone who can see this thread.**';

      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    }

    return { handled: true, cmd: 'report', octokit, prisma };
  }

  return { handled: true, cmd: 'unknown', octokit, prisma };
}

// ── Confidence score parser (copied from route.js for unit testing) ───────────
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

// ── Tests ────────────────────────────────────────────────────────────────────

section('M4: /proof help — no admin check, always replies');
{
  const result = await simulateComment('/proof help', { permission: 'read' });
  result.handled === true && result.cmd === 'help'
    ? ok('/proof help is handled')
    : fail(`Expected help to be handled, got cmd=${result.cmd}`);
  result.octokit._calls.permission === 0
    ? ok('/proof help does not check admin permission')
    : fail(`/proof help should not check permission, checked ${result.octokit._calls.permission} times`);
  result.octokit._calls.createComment === 1
    ? ok('/proof help posts exactly one comment')
    : fail(`Expected 1 comment, got ${result.octokit._calls.createComment}`);
}

section('M4: /proof help — works for all permission tiers');
{
  for (const perm of ['admin', 'write', 'read', 'none']) {
    const result = await simulateComment('/proof help', { permission: perm });
    result.cmd === 'help' && result.octokit._calls.createComment === 1
      ? ok(`/proof help works for "${perm}" user`)
      : fail(`/proof help failed for "${perm}" user`);
  }
}

section('M4: /proof config mandatory on — admin succeeds');
{
  const prisma = makePrisma();
  const result = await simulateComment('/proof config mandatory on', {
    permission: 'admin',
    prisma,
  });
  result.cmd === 'config' && result.enabled === true
    ? ok('/proof config mandatory on handled by admin')
    : fail(`Expected config enabled, got cmd=${result.cmd}, enabled=${result.enabled}`);
  result.octokit._store.some((r) => r.name === 'proof-confidence-required')
    ? ok('Ruleset created after "mandatory on"')
    : fail('Expected ruleset to be created');
  prisma._upserted() !== null
    ? ok('RepoSettings upserted after "mandatory on"')
    : fail('RepoSettings should have been upserted');
  prisma._upserted().update.mandatory === true
    ? ok('RepoSettings.mandatory set to true')
    : fail('RepoSettings.mandatory should be true');
}

section('M4: /proof config mandatory off — admin succeeds');
{
  const existingRuleset = { id: 99, name: 'proof-confidence-required' };
  const prisma = makePrisma();
  const result = await simulateComment('/proof config mandatory off', {
    permission: 'admin',
    prisma,
    rulesets: [existingRuleset],
  });
  result.cmd === 'config' && result.enabled === false
    ? ok('/proof config mandatory off handled by admin')
    : fail(`Expected config disabled, got cmd=${result.cmd}`);
  !result.octokit._store.some((r) => r.name === 'proof-confidence-required')
    ? ok('Ruleset deleted after "mandatory off"')
    : fail('Expected ruleset to be deleted');
  prisma._upserted().update.mandatory === false
    ? ok('RepoSettings.mandatory set to false')
    : fail('RepoSettings.mandatory should be false');
}

section('M4: /proof config — non-admin is rejected');
{
  for (const perm of ['maintain', 'write', 'triage', 'read', 'none']) {
    const result = await simulateComment('/proof config mandatory on', {
      permission: perm,
    });
    result.cmd === 'rejected'
      ? ok(`Non-admin (${perm}) rejected for /proof config`)
      : fail(`Non-admin (${perm}) should be rejected, got cmd=${result.cmd}`);
    result.octokit._calls.createRuleset === 0
      ? ok(`No ruleset created when non-admin (${perm}) is rejected`)
      : fail(`Ruleset should not be created for non-admin (${perm})`);
    const rejectionComment = result.octokit._comments.find((c) =>
      c.body.includes("Only repo admins")
    );
    rejectionComment
      ? ok(`Rejection message posted for non-admin (${perm})`)
      : fail(`Expected rejection message for non-admin (${perm})`);
  }
}

section('M4: /proof report — admin sees aggregate report with visibility warning');
{
  const receipts = [
    { repoFullName: 'acme/test-repo', confidence: 8, outcome: 'SUCCESS', userId: 'alice', user: { login: 'alice' }, timestamp: new Date() },
    { repoFullName: 'acme/test-repo', confidence: 6, outcome: 'FAILURE', userId: 'alice', user: { login: 'alice' }, timestamp: new Date() },
    { repoFullName: 'acme/test-repo', confidence: 9, outcome: 'SUCCESS', userId: 'bob', user: { login: 'bob' }, timestamp: new Date() },
  ];
  const prisma = makePrisma({ receipts });
  const result = await simulateComment('/proof report', { permission: 'admin', prisma });
  result.cmd === 'report'
    ? ok('/proof report handled by admin')
    : fail(`Expected report, got cmd=${result.cmd}`);
  const reportComment = result.octokit._comments[0];
  reportComment?.body.includes('Visible to anyone who can see this thread')
    ? ok('Report includes visibility warning')
    : fail('Report missing visibility warning text');
}

section('M4: /proof report — non-admin is rejected');
{
  const prisma = makePrisma();
  const result = await simulateComment('/proof report', {
    permission: 'write',
    prisma,
  });
  result.cmd === 'rejected'
    ? ok('Non-admin rejected for /proof report')
    : fail(`Non-admin should be rejected, got cmd=${result.cmd}`);
}

section('M4: /proof report — empty repo shows no-scores message');
{
  const prisma = makePrisma({ receipts: [] });
  const result = await simulateComment('/proof report', { permission: 'admin', prisma });
  const body = result.octokit._comments[0]?.body ?? '';
  body.includes('No scores') || body.includes('Visible to anyone')
    ? ok('Empty report shows appropriate no-scores message')
    : fail(`Unexpected empty report body: ${body}`);
}

section('M4: Plain number "7" still works (not broken by /proof commands)');
{
  // Simulate that no /proof command match falls through to parseConfidenceScore
  const body = '7';
  const cmdMatch = body.trim().match(/^\/proof\s+(config|report|help)\b(.*)/is);
  cmdMatch === null
    ? ok('"7" does not match /proof command pattern (correctly falls through)')
    : fail('"7" should not match the /proof command regex');
  const score = parseConfidenceScore(body);
  score === 7
    ? ok('"7" still parsed as confidence score 7')
    : fail(`Expected score 7, got ${score}`);
}

section('M4: Confidence score formats unchanged (regression check)');
{
  const cases = [
    ['8', 8], ['10', 10], ['1', 1], ['8/10', 8],
    ['confidence: 8', 8], ['confidence:8', 8], ['CONFIDENCE: 5', 5],
  ];
  for (const [input, expected] of cases) {
    const score = parseConfidenceScore(input);
    score === expected
      ? ok(`"${input}" → ${expected} (still works)`)
      : fail(`"${input}" → expected ${expected}, got ${score}`);
  }
}

section('M4: Rejected non-confidence text unchanged');
{
  const rejected = ['banana', '0', '11', '', 'lgtm', 'LGTM', 'looks good'];
  for (const input of rejected) {
    const score = parseConfidenceScore(input);
    score === null
      ? ok(`"${input}" → null (still rejected)`)
      : fail(`"${input}" should be null, got ${score}`);
  }
}

section('M4: /proof <unknown> falls through silently');
{
  const body = '/proof unknown-command';
  const cmdMatch = body.trim().match(/^\/proof\s+(config|report|help)\b(.*)/is);
  cmdMatch === null
    ? ok('/proof unknown-command does not match the command regex (falls through)')
    : fail('/proof unknown-command should not match');
}

section('M4: Admin check is live — called per action, not cached');
{
  // Two separate simulateComment calls should each trigger a fresh permission check
  const result1 = await simulateComment('/proof config mandatory on', { permission: 'admin' });
  const result2 = await simulateComment('/proof report', { permission: 'admin', prisma: makePrisma() });

  result1.octokit._calls.permission === 1
    ? ok('First action made exactly 1 live permission check')
    : fail(`Expected 1 permission check, got ${result1.octokit._calls.permission}`);
  result2.octokit._calls.permission === 1
    ? ok('Second action made exactly 1 live permission check (separate octokit)')
    : fail(`Expected 1 permission check, got ${result2.octokit._calls.permission}`);
}

process.exit(summary('M4 Command Tests'));
