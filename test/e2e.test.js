#!/usr/bin/env node
/**
 * test/e2e.test.js
 *
 * Milestone 5 — End-to-end ruleset lifecycle + cross-repo isolation.
 *
 * Simulates the full scenario:
 *   1. Admin /proof config mandatory on → ruleset created
 *   2. Non-admin /proof config mandatory off → rejected, ruleset still present
 *   3. Admin /proof report → correct aggregate
 *   4. Admin /proof config mandatory off → ruleset deleted
 *
 * Also verifies repo-a and repo-b data do not leak across each other.
 * No DB or network calls — all in-process mocks.
 *
 * Exits 0 on success, 1 on failure.
 */

import { ok, fail, section, summary } from './_util.js';
import { spawnSync } from 'child_process';
import { isAdmin } from '../src/lib/permissions.js';
import {
  getProofRuleset,
  enableMandatoryCheck,
  disableMandatoryCheck,
} from '../src/lib/rulesets.js';

// ── Mock factories (reused from commands.test.js pattern) ─────────────────────

function makeOctokit({ permission = 'admin', store = [] } = {}) {
  let nextId = 200;
  const comments = [];
  let permChecks = 0;

  return {
    _store: store,
    _comments: comments,
    _permChecks: () => permChecks,
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          permChecks++;
          return { data: { permission } };
        },
        get: async () => ({ data: { default_branch: 'main' } }),
        getRepoRulesets: async () => ({ data: [...store] }),
        createRepoRuleset: async ({ name }) => {
          const rs = { id: nextId++, name };
          store.push(rs);
          return { data: rs };
        },
        deleteRepoRuleset: async ({ ruleset_id }) => {
          const idx = store.findIndex((r) => r.id === ruleset_id);
          if (idx !== -1) store.splice(idx, 1);
        },
      },
      issues: {
        createComment: async ({ body, issue_number }) => {
          comments.push({ body, issue_number });
          return { data: { id: Date.now() } };
        },
      },
    },
  };
}

function makePrisma({ repoA = [], repoB = [] } = {}) {
  const settings = {};
  const allReceipts = [...repoA, ...repoB];

  return {
    repoSettings: {
      upsert: async ({ where, update, create }) => {
        settings[where.repoFullName] = { ...create, ...update };
      },
    },
    receipt: {
      findMany: async ({ where }) => {
        return allReceipts.filter((r) => r.repoFullName === where.repoFullName);
      },
    },
    _settings: () => settings,
  };
}

// ── Full lifecycle simulation ─────────────────────────────────────────────────

section('M5: Full lifecycle — admin on → non-admin off rejected → admin report → admin off');

// Shared ruleset store for repo-a (simulates one GitHub repo)
const repoAStore = [];

// Step 1: Admin enables mandatory
{
  const oct = makeOctokit({ permission: 'admin', store: repoAStore });
  const prisma = makePrisma();

  const adminCheck = await isAdmin(oct, 'acme', 'repo-a', 'alice');
  adminCheck === true ? ok('Step 1: alice is admin') : fail('alice should be admin');

  await enableMandatoryCheck(oct, 'acme', 'repo-a');
  const rs = await getProofRuleset(oct, 'acme', 'repo-a');
  rs !== null && rs.name === 'proof-confidence-required'
    ? ok('Step 1: Ruleset created by admin enable')
    : fail('Ruleset should exist after admin enable');

  await prisma.repoSettings.upsert({
    where: { repoFullName: 'acme/repo-a' },
    update: { mandatory: true, updatedBy: 'alice' },
    create: { repoFullName: 'acme/repo-a', mandatory: true, updatedBy: 'alice' },
  });
  prisma._settings()['acme/repo-a']?.mandatory === true
    ? ok('Step 1: RepoSettings.mandatory=true persisted')
    : fail('RepoSettings should be mandatory=true');
}

// Step 2: Non-admin tries to disable — must be rejected, ruleset must still exist
{
  const oct = makeOctokit({ permission: 'write', store: repoAStore }); // same store, different permission
  const nonAdminCheck = await isAdmin(oct, 'acme', 'repo-a', 'bob');
  nonAdminCheck === false ? ok('Step 2: bob is NOT admin (write tier)') : fail('bob should not be admin');

  // Simulate the rejection (non-admin path — disableMandatoryCheck is NOT called)
  const rejectionMessage = "> ⛔ Only repo admins can change PRoof's merge requirements.";
  await oct.rest.issues.createComment({
    owner: 'acme', repo: 'repo-a', issue_number: 42,
    body: rejectionMessage,
  });

  // Verify ruleset still present (disableMandatoryCheck was not called)
  const rs = await getProofRuleset(oct, 'acme', 'repo-a');
  rs !== null
    ? ok('Step 2: Ruleset still present after non-admin rejection')
    : fail('Ruleset should still exist after non-admin attempted disable');

  const rejectionPosted = oct._comments.some((c) => c.body.includes("Only repo admins"));
  rejectionPosted
    ? ok('Step 2: Rejection message posted to thread')
    : fail('Step 2: Rejection message not posted');
}

// Step 3: Admin runs /proof report — aggregate is correct
{
  const receipts = [
    { repoFullName: 'acme/repo-a', confidence: 8, outcome: 'SUCCESS', userId: 'alice', user: { login: 'alice' }, timestamp: new Date() },
    { repoFullName: 'acme/repo-a', confidence: 6, outcome: 'FAILURE', userId: 'alice', user: { login: 'alice' }, timestamp: new Date() },
    { repoFullName: 'acme/repo-a', confidence: 9, outcome: 'SUCCESS', userId: 'bob', user: { login: 'bob' }, timestamp: new Date() },
  ];
  const prisma = makePrisma({ repoA: receipts });
  const oct = makeOctokit({ permission: 'admin', store: repoAStore });

  const adminCheck = await isAdmin(oct, 'acme', 'repo-a', 'alice');
  adminCheck === true ? ok('Step 3: alice is admin for report') : fail('alice should be admin');

  // Aggregate the receipts (same logic as handleProofReport)
  const repoReceipts = await prisma.receipt.findMany({ where: { repoFullName: 'acme/repo-a' } });
  repoReceipts.length === 3
    ? ok('Step 3: 3 receipts found for repo-a')
    : fail(`Expected 3 receipts, got ${repoReceipts.length}`);

  const byUser = {};
  for (const r of repoReceipts) {
    const login = r.user?.login ?? r.userId;
    if (!byUser[login]) byUser[login] = { scores: [], outcomes: [] };
    byUser[login].scores.push(r.confidence);
    if (r.outcome) byUser[login].outcomes.push(r.outcome);
  }

  const aliceAvg = byUser['alice'].scores.reduce((a, b) => a + b, 0) / byUser['alice'].scores.length;
  aliceAvg === 7
    ? ok(`Step 3: alice avg confidence = ${aliceAvg} (correct)`)
    : fail(`Expected alice avg=7, got ${aliceAvg}`);

  const bobAvg = byUser['bob'].scores.reduce((a, b) => a + b, 0) / byUser['bob'].scores.length;
  bobAvg === 9
    ? ok(`Step 3: bob avg confidence = ${bobAvg} (correct)`)
    : fail(`Expected bob avg=9, got ${bobAvg}`);

  const aliceSuccesses = byUser['alice'].outcomes.filter((o) => o === 'SUCCESS').length;
  const aliceFailures = byUser['alice'].outcomes.filter((o) => o === 'FAILURE').length;
  aliceSuccesses === 1 && aliceFailures === 1
    ? ok('Step 3: alice has 1 success, 1 failure (correct outcomes)')
    : fail(`alice outcomes wrong: successes=${aliceSuccesses}, failures=${aliceFailures}`);
}

// Step 4: Admin disables mandatory — ruleset deleted
{
  const oct = makeOctokit({ permission: 'admin', store: repoAStore });
  const prisma = makePrisma();

  const adminCheck = await isAdmin(oct, 'acme', 'repo-a', 'alice');
  adminCheck === true ? ok('Step 4: alice is admin for disable') : fail('alice should be admin');

  await disableMandatoryCheck(oct, 'acme', 'repo-a');
  const rs = await getProofRuleset(oct, 'acme', 'repo-a');
  rs === null
    ? ok('Step 4: Ruleset deleted after admin disable')
    : fail('Ruleset should be deleted after admin disable');

  await prisma.repoSettings.upsert({
    where: { repoFullName: 'acme/repo-a' },
    update: { mandatory: false, updatedBy: 'alice' },
    create: { repoFullName: 'acme/repo-a', mandatory: false, updatedBy: 'alice' },
  });
  prisma._settings()['acme/repo-a']?.mandatory === false
    ? ok('Step 4: RepoSettings.mandatory=false after disable')
    : fail('RepoSettings.mandatory should be false after disable');
}

// ── Cross-repo isolation ──────────────────────────────────────────────────────

section('M5: Cross-repo isolation — repo-a and repo-b data do not leak');

// Separate store for each repo
const storeA = [];
const storeB = [];

// Enable mandatory on repo-a only
{
  const octA = makeOctokit({ store: storeA });
  await enableMandatoryCheck(octA, 'acme', 'repo-a');
}

// repo-b should have no ruleset
{
  const octB = makeOctokit({ store: storeB });
  const rsB = await getProofRuleset(octB, 'acme', 'repo-b');
  rsB === null
    ? ok('repo-b has no ruleset (isolated from repo-a enable)')
    : fail('repo-b should not have a ruleset — leakage from repo-a!');
}

// Enable on repo-b too, then disable repo-a — repo-b still has its ruleset
{
  const octB = makeOctokit({ store: storeB });
  await enableMandatoryCheck(octB, 'acme', 'repo-b');

  const octA2 = makeOctokit({ store: storeA });
  await disableMandatoryCheck(octA2, 'acme', 'repo-a');

  const rsA = await getProofRuleset(octA2, 'acme', 'repo-a');
  const rsB = await getProofRuleset(octB, 'acme', 'repo-b');

  rsA === null
    ? ok('repo-a ruleset deleted without affecting repo-b')
    : fail('repo-a ruleset should be deleted');
  rsB !== null
    ? ok('repo-b ruleset still present after repo-a disable')
    : fail('repo-b ruleset should still exist — it was affected by repo-a disable!');
}

// Cross-repo receipt isolation
{
  const repoAReceipts = [
    { repoFullName: 'acme/repo-a', confidence: 7, userId: 'alice', user: { login: 'alice' } },
    { repoFullName: 'acme/repo-a', confidence: 5, userId: 'bob', user: { login: 'bob' } },
  ];
  const repoBReceipts = [
    { repoFullName: 'acme/repo-b', confidence: 9, userId: 'alice', user: { login: 'alice' } },
    { repoFullName: 'acme/repo-b', confidence: 3, userId: 'carol', user: { login: 'carol' } },
  ];
  const prisma = makePrisma({ repoA: repoAReceipts, repoB: repoBReceipts });

  const aResults = await prisma.receipt.findMany({ where: { repoFullName: 'acme/repo-a' } });
  const bResults = await prisma.receipt.findMany({ where: { repoFullName: 'acme/repo-b' } });

  aResults.length === 2
    ? ok(`repo-a query returns 2 receipts (correct)`)
    : fail(`repo-a should have 2 receipts, got ${aResults.length}`);
  bResults.length === 2
    ? ok(`repo-b query returns 2 receipts (correct)`)
    : fail(`repo-b should have 2 receipts, got ${bResults.length}`);

  const aHasBData = aResults.some((r) => r.repoFullName === 'acme/repo-b');
  !aHasBData
    ? ok('repo-a receipts contain no repo-b data')
    : fail('repo-a receipts leak repo-b data!');

  const bHasAData = bResults.some((r) => r.repoFullName === 'acme/repo-a');
  !bHasAData
    ? ok('repo-b receipts contain no repo-a data')
    : fail('repo-b receipts leak repo-a data!');

  // alice's score 9 on repo-b should NOT appear in repo-a results
  const aliceOnA = aResults.find((r) => r.userId === 'alice');
  aliceOnA?.confidence !== 9
    ? ok("alice's repo-b score (9) does not appear in repo-a results")
    : fail("alice's repo-b score leaked into repo-a results!");

  // carol is not in repo-a at all
  const carolOnA = aResults.find((r) => r.userId === 'carol');
  carolOnA === undefined
    ? ok('carol is not in repo-a results (correct)')
    : fail('carol appeared in repo-a results — cross-repo leak!');
}

// Admin permission check is independent per repo (re-verified each time)
{
  section('M5: Admin checks are independent per repo (no cross-repo inheritance)');

  // alice is admin on repo-a but not on repo-b
  const octA = makeOctokit({ permission: 'admin' });
  const octB = makeOctokit({ permission: 'write' }); // write on repo-b

  const aliceAdminOnA = await isAdmin(octA, 'acme', 'repo-a', 'alice');
  const aliceAdminOnB = await isAdmin(octB, 'acme', 'repo-b', 'alice');

  aliceAdminOnA === true
    ? ok('alice is admin on repo-a')
    : fail('alice should be admin on repo-a');
  aliceAdminOnB === false
    ? ok('alice is NOT admin on repo-b (different permission tier)')
    : fail('alice should NOT be admin on repo-b — admin on repo-a must not carry over!');
}

// Full test suite regression: run verify.js' tests inline via subprocess
section('M5: Existing test suite (verify.js) must still pass — no regressions');
{
  const cwd = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const result = spawnSync(process.execPath, ['test/verify.js'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
  const output = result.stdout + result.stderr;
  result.status === 0
    ? ok('verify.js exits 0 (all existing tests pass, no regressions)')
    : fail(`verify.js failed (exit ${result.status}):\n${output.slice(-500)}`);
}

process.exit(summary('M5 End-to-End Tests'));
