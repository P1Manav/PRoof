#!/usr/bin/env node
/**
 * test/permissions.test.js
 *
 * Unit tests for src/lib/permissions.js.
 * Uses in-process mock Octokit — no network calls.
 *
 * Exits 0 on success, 1 on failure.
 */

import { ok, fail, section, summary } from './_util.js';
import { getUserPermission, isAdmin } from '../src/lib/permissions.js';

// ── Mock factory ─────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Octokit that returns `permission` for
 * getCollaboratorPermissionLevel, or throws a 404 if `notFound` is true.
 */
function mockOctokit(permission, { notFound = false } = {}) {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async ({ owner, repo, username }) => {
          if (notFound) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          // Record the call args so tests can assert they were passed correctly.
          mockOctokit._lastCall = { owner, repo, username };
          return { data: { permission } };
        },
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

section('M1: getUserPermission — returns correct permission string');

{
  for (const tier of ['admin', 'maintain', 'write', 'triage', 'read', 'none']) {
    const oct = mockOctokit(tier);
    const result = await getUserPermission(oct, 'acme', 'repo', 'alice');
    result === tier
      ? ok(`getUserPermission returns "${tier}" correctly`)
      : fail(`Expected "${tier}", got "${result}"`);
  }
}

section('M1: getUserPermission — returns "none" for 404 (non-collaborator)');

{
  const oct = mockOctokit(null, { notFound: true });
  const result = await getUserPermission(oct, 'acme', 'repo', 'stranger');
  result === 'none'
    ? ok('404 response mapped to "none"')
    : fail(`Expected "none" for 404, got "${result}"`);
}

section('M1: isAdmin — true only for exact "admin"');

{
  const adminOct = mockOctokit('admin');
  const adminResult = await isAdmin(adminOct, 'acme', 'repo', 'alice');
  adminResult === true
    ? ok('isAdmin returns true for "admin"')
    : fail('isAdmin should return true for "admin"');
}

{
  for (const tier of ['maintain', 'write', 'triage', 'read', 'none']) {
    const oct = mockOctokit(tier);
    const result = await isAdmin(oct, 'acme', 'repo', 'bob');
    result === false
      ? ok(`isAdmin returns false for "${tier}"`)
      : fail(`isAdmin should return false for "${tier}", got ${result}`);
  }
}

{
  // 404 (non-collaborator) must also be false
  const oct = mockOctokit(null, { notFound: true });
  const result = await isAdmin(oct, 'acme', 'repo', 'stranger');
  result === false
    ? ok('isAdmin returns false for non-collaborator (404)')
    : fail('isAdmin should return false when user is not a collaborator');
}

section('M1: No caching — each call hits the API independently');

{
  let callCount = 0;
  const countingOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          callCount++;
          return { data: { permission: 'admin' } };
        },
      },
    },
  };

  await isAdmin(countingOctokit, 'acme', 'repo', 'alice');
  await isAdmin(countingOctokit, 'acme', 'repo', 'alice');
  await isAdmin(countingOctokit, 'acme', 'repo', 'alice');

  callCount === 3
    ? ok('Three separate isAdmin calls each hit the API (no caching)')
    : fail(`Expected 3 API calls, got ${callCount}`);
}

process.exit(summary('M1 Permission Tests'));
