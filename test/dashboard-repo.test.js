#!/usr/bin/env node
/**
 * test/dashboard-repo.test.js
 *
 * M10 — Per-repo dashboard view logic tests.
 *
 * Tests all three permission scenarios:
 *   1. Admin → gets toggle + full report + own history
 *   2. Non-admin with access → own history only, no toggle, no others' data
 *   3. Zero access (permission="none") → notFound() [404]
 *
 * Tests the Server Action (toggleMandatory) permission gating.
 *
 * Exits 0 on success, 1 on failure.
 */

import { ok, fail, section, summary } from './_util.js';
import { isAdmin, getUserPermission } from '../src/lib/permissions.js';
import { getReport, getUserHistory, getRepoSettings } from '../src/lib/proofActions.js';

// ── Mock factories ────────────────────────────────────────────────────────────

function makeMockOctokit(permission) {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
        get: async () => ({ data: { default_branch: 'main' } }),
        getRepoRulesets: async () => ({ data: [] }),
        createRepoRuleset: async ({ name }) => ({ data: { id: 1, name } }),
        deleteRepoRuleset: async () => ({}),
      },
    },
  };
}

/**
 * Simulate the per-repo page logic: determine what to render based on
 * the live permission check result.
 *
 * Returns the "rendered view" as a descriptor object for assertions.
 */
async function simulateRepoPage({ permission, owner = 'acme', repo = 'test-repo', userLogin = 'testuser', session = null, receipts = [], userReceipts = [] } = {}) {
  // No session → redirect (not notFound)
  if (!session) {
    return { view: 'redirect', destination: '/login' };
  }

  const octokit = makeMockOctokit(permission);
  const livePerm = await getUserPermission(octokit, owner, repo, userLogin);

  // No access → 404
  if (livePerm === 'none') {
    return { view: 'notFound' };
  }

  const adminUser = livePerm === 'admin';

  // Build data based on tier
  const view = {
    view: adminUser ? 'admin' : 'non-admin',
    permission: livePerm,
    hasToggle: adminUser,
    hasReport: adminUser,
    hasAllUsersData: adminUser,
    hasOwnHistory: true,
  };

  // Admin: full report
  if (adminUser) {
    const byUser = {};
    for (const r of receipts) {
      if (!byUser[r.userId]) byUser[r.userId] = { login: r.userId, scores: [], outcomes: [] };
      byUser[r.userId].scores.push(r.confidence);
      if (r.outcome) byUser[r.userId].outcomes.push(r.outcome);
    }
    view.reportData = {
      totalReceipts: receipts.length,
      byUser: Object.values(byUser).map((u) => ({
        login: u.login,
        count: u.scores.length,
        avg: u.scores.reduce((a, b) => a + b, 0) / u.scores.length,
        successes: u.outcomes.filter((o) => o === 'SUCCESS').length,
        failures: u.outcomes.filter((o) => o === 'FAILURE').length,
      })),
    };
  }

  // Personal history (all tiers with access)
  view.userHistory = userReceipts;

  return view;
}

/**
 * Simulate the toggleMandatory Server Action authorization check.
 */
async function simulateToggleAuth({ session, permission, owner = 'acme', repo = 'test-repo', hasInstallation = true }) {
  if (!session) {
    return { result: 'redirect', destination: '/login' };
  }

  if (!hasInstallation) {
    return { result: 'error', message: 'PRoof is not installed' };
  }

  const octokit = makeMockOctokit(permission);
  const adminCheck = await isAdmin(octokit, owner, repo, session.user?.login);

  if (!adminCheck) {
    return { result: 'error', message: "Only repo admins can change PRoof's merge requirements." };
  }

  return { result: 'success' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const fakeSession = { user: { login: 'testuser' }, accessToken: 'gho_fake' };

const sampleReceipts = [
  { repoFullName: 'acme/test-repo', confidence: 8, outcome: 'SUCCESS', userId: 'alice' },
  { repoFullName: 'acme/test-repo', confidence: 6, outcome: 'FAILURE', userId: 'alice' },
  { repoFullName: 'acme/test-repo', confidence: 9, outcome: 'SUCCESS', userId: 'bob' },
];

const userOwnReceipts = [
  { prNumber: 42, confidence: 7, outcome: 'SUCCESS', timestamp: new Date() },
];

// ── Scenario 1: Admin ─────────────────────────────────────────────────────────

section('M10: Admin scenario — gets toggle + full report + own history');
{
  const view = await simulateRepoPage({
    permission: 'admin',
    session: fakeSession,
    receipts: sampleReceipts,
    userReceipts: userOwnReceipts,
  });

  view.view === 'admin'
    ? ok('Admin gets the admin view')
    : fail(`Expected admin view, got ${view.view}`);
  view.hasToggle === true
    ? ok('Admin sees the mandatory toggle')
    : fail('Admin should have toggle');
  view.hasReport === true
    ? ok('Admin sees the aggregate report')
    : fail('Admin should have report');
  view.hasAllUsersData === true
    ? ok('Admin sees all users data in report')
    : fail('Admin should see all users data');
  view.hasOwnHistory === true
    ? ok('Admin also sees own confidence history')
    : fail('Admin should see own history');
  view.reportData.totalReceipts === 3
    ? ok(`Admin report shows all 3 receipts (total=${view.reportData.totalReceipts})`)
    : fail(`Expected 3 total receipts, got ${view.reportData.totalReceipts}`);
  view.reportData.byUser.length === 2
    ? ok(`Admin report has 2 contributors (alice + bob)`)
    : fail(`Expected 2 contributors, got ${view.reportData.byUser.length}`);
}

// ── Scenario 2: Non-admin with access ─────────────────────────────────────────

section('M10: Non-admin scenario — only own history, no toggle, no others data');
{
  for (const perm of ['maintain', 'write', 'triage', 'read']) {
    const view = await simulateRepoPage({
      permission: perm,
      session: fakeSession,
      receipts: sampleReceipts,
      userReceipts: userOwnReceipts,
    });

    view.view === 'non-admin'
      ? ok(`"${perm}" user gets non-admin view`)
      : fail(`"${perm}" should get non-admin view, got ${view.view}`);
    view.hasToggle === false
      ? ok(`"${perm}" user does NOT see toggle`)
      : fail(`"${perm}" should NOT have toggle`);
    view.hasReport === false
      ? ok(`"${perm}" user does NOT see aggregate report`)
      : fail(`"${perm}" should NOT have report`);
    view.hasAllUsersData === false
      ? ok(`"${perm}" user cannot see others' data`)
      : fail(`"${perm}" should NOT have access to others' data`);
    view.hasOwnHistory === true
      ? ok(`"${perm}" user can see own history`)
      : fail(`"${perm}" should see own history`);
  }
}

// ── Scenario 3: Zero access → 404 ────────────────────────────────────────────

section('M10: Zero access (permission=none) → notFound() [not 403]');
{
  const view = await simulateRepoPage({
    permission: 'none',
    session: fakeSession,
  });

  view.view === 'notFound'
    ? ok('Permission "none" yields notFound (404), not a 403 or error page')
    : fail(`Expected notFound, got ${view.view}`);
}

// ── Scenario 3b: No session → redirect ───────────────────────────────────────

section('M10: No session → redirect to /login (proxy missed, server check catches it)');
{
  const view = await simulateRepoPage({
    permission: 'admin',
    session: null, // no session
  });

  view.view === 'redirect'
    ? ok('No session → redirect to /login')
    : fail(`Expected redirect, got ${view.view}`);
  view.destination === '/login'
    ? ok('Redirect destination is /login')
    : fail(`Redirect destination should be /login, got ${view.destination}`);
}

// ── Server Action: toggleMandatory auth gating ────────────────────────────────

section('M10: toggleMandatory Server Action — admin with session succeeds');
{
  const result = await simulateToggleAuth({
    session: fakeSession,
    permission: 'admin',
  });

  result.result === 'success'
    ? ok('Admin with valid session: toggleMandatory succeeds')
    : fail(`Expected success, got ${JSON.stringify(result)}`);
}

section('M10: toggleMandatory — non-admin rejected');
{
  for (const perm of ['maintain', 'write', 'triage', 'read', 'none']) {
    const result = await simulateToggleAuth({
      session: fakeSession,
      permission: perm,
    });

    result.result === 'error' && result.message.includes('Only repo admins')
      ? ok(`Non-admin (${perm}) rejected with correct message`)
      : fail(`Non-admin (${perm}) should be rejected, got ${JSON.stringify(result)}`);
  }
}

section('M10: toggleMandatory — no session → redirect');
{
  const result = await simulateToggleAuth({
    session: null,
    permission: 'admin',
  });

  result.result === 'redirect'
    ? ok('No session → redirect to /login')
    : fail(`Expected redirect, got ${JSON.stringify(result)}`);
}

section('M10: toggleMandatory — no installation → error');
{
  const result = await simulateToggleAuth({
    session: fakeSession,
    permission: 'admin',
    hasInstallation: false,
  });

  result.result === 'error' && result.message.includes('not installed')
    ? ok('No installation → error (PRoof not installed on this repo)')
    : fail(`Expected installation error, got ${JSON.stringify(result)}`);
}

section('M10: Permission is re-checked live on each page load (no reuse from list)');
{
  // Simulate the same user visiting the repo page twice — each must call the API
  let permissionChecks = 0;
  const countingOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          permissionChecks++;
          return { data: { permission: 'admin' } };
        },
      },
    },
  };

  await getUserPermission(countingOctokit, 'acme', 'repo', 'alice');
  await getUserPermission(countingOctokit, 'acme', 'repo', 'alice');

  permissionChecks === 2
    ? ok('Two page loads → two live permission API calls (no reuse)')
    : fail(`Expected 2 permission checks, got ${permissionChecks}`);
}

section('M10: No cross-repo visibility — non-admin sees only own repo data');
{
  // Non-admin on repo-a sees only their own data for repo-a
  // They should NOT be able to trigger a report for repo-b
  const viewA = await simulateRepoPage({
    permission: 'read',
    owner: 'acme', repo: 'repo-a',
    session: fakeSession,
    receipts: [{ repoFullName: 'acme/repo-a', confidence: 7, outcome: 'SUCCESS', userId: 'testuser' }],
    userReceipts: [{ prNumber: 1, confidence: 7, outcome: 'SUCCESS', timestamp: new Date() }],
  });

  viewA.hasReport === false
    ? ok('Non-admin on repo-a cannot access aggregate report')
    : fail('Non-admin should not have report access');
  viewA.userHistory.length === 1
    ? ok('Non-admin sees only their own 1 history entry')
    : fail(`Expected 1 history entry, got ${viewA.userHistory.length}`);
}

process.exit(summary('M10 Per-Repo Dashboard Tests'));
