#!/usr/bin/env node
/**
 * test/rulesets.test.js
 *
 * Unit tests for src/lib/rulesets.js.
 * Uses in-process mock Octokit — no network calls.
 *
 * Exits 0 on success, 1 on failure.
 */

import { ok, fail, section, summary } from './_util.js';
import {
  getProofRuleset,
  enableMandatoryCheck,
  disableMandatoryCheck,
} from '../src/lib/rulesets.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

const PROOF_NAME = 'proof-confidence-required';

function makeRuleset(id, name) {
  return { id, name, target: 'branch', enforcement: 'active' };
}

/**
 * Build a stateful mock of the GitHub Rulesets API.
 * State is stored in the `store` map: repo key → array of rulesets.
 */
function makeMockOctokit(initialRulesets = []) {
  // Clone so tests don't share state
  const store = [...initialRulesets];
  let nextId = initialRulesets.length + 1;

  const created = []; // Track names of rulesets created
  const deleted = []; // Track IDs of rulesets deleted

  const octokit = {
    rest: {
      repos: {
        getRepoRulesets: async () => ({ data: [...store] }),
        get: async () => ({ data: { default_branch: 'main' } }),
        createRepoRuleset: async ({ name, target, enforcement, conditions, rules }) => {
          const newRS = makeRuleset(nextId++, name);
          store.push(newRS);
          created.push(name);
          return { data: newRS };
        },
        deleteRepoRuleset: async ({ ruleset_id }) => {
          const idx = store.findIndex((r) => r.id === ruleset_id);
          if (idx !== -1) {
            deleted.push(store[idx].id);
            store.splice(idx, 1);
          }
          return {};
        },
      },
    },
    _store: store,
    _created: created,
    _deleted: deleted,
  };

  return octokit;
}

// ── M3: getProofRuleset ───────────────────────────────────────────────────────

section('M3: getProofRuleset — returns null when no rulesets exist');
{
  const oct = makeMockOctokit([]);
  const result = await getProofRuleset(oct, 'acme', 'repo');
  result === null
    ? ok('Returns null when no rulesets on repo')
    : fail(`Expected null, got ${JSON.stringify(result)}`);
}

section('M3: getProofRuleset — returns null when other rulesets exist but not the proof one');
{
  const oct = makeMockOctokit([
    makeRuleset(1, 'branch-protection-v1'),
    makeRuleset(2, 'require-signed-commits'),
  ]);
  const result = await getProofRuleset(oct, 'acme', 'repo');
  result === null
    ? ok('Returns null when proof ruleset absent (others present)')
    : fail(`Expected null, got ${JSON.stringify(result)}`);
}

section('M3: getProofRuleset — returns the proof ruleset when present');
{
  const rs = makeRuleset(42, PROOF_NAME);
  const oct = makeMockOctokit([
    makeRuleset(1, 'other-ruleset'),
    rs,
    makeRuleset(3, 'another-one'),
  ]);
  const result = await getProofRuleset(oct, 'acme', 'repo');
  result !== null && result.id === 42
    ? ok('Returns the proof ruleset with correct id')
    : fail(`Expected ruleset id=42, got ${JSON.stringify(result)}`);
}

section('M3: getProofRuleset — does NOT return or touch other rulesets');
{
  const oct = makeMockOctokit([
    makeRuleset(1, 'branch-protection-v1'),
    makeRuleset(2, PROOF_NAME),
    makeRuleset(3, 'require-signed-commits'),
  ]);
  const result = await getProofRuleset(oct, 'acme', 'repo');
  result !== null && result.name === PROOF_NAME
    ? ok('Only returns the ruleset named exactly "proof-confidence-required"')
    : fail(`Wrong ruleset returned: ${JSON.stringify(result)}`);
}

// ── M3: enableMandatoryCheck ──────────────────────────────────────────────────

section('M3: enableMandatoryCheck — creates the ruleset when absent');
{
  const oct = makeMockOctokit([]);
  await enableMandatoryCheck(oct, 'acme', 'repo');
  const present = await getProofRuleset(oct, 'acme', 'repo');
  present !== null && present.name === PROOF_NAME
    ? ok('Ruleset created when absent')
    : fail('Ruleset should have been created');
  oct._created.includes(PROOF_NAME)
    ? ok('Exactly the proof ruleset was created')
    : fail('Created list does not contain the proof ruleset name');
}

section('M3: enableMandatoryCheck — idempotent (two calls → one ruleset created)');
{
  const oct = makeMockOctokit([]);
  await enableMandatoryCheck(oct, 'acme', 'repo');
  await enableMandatoryCheck(oct, 'acme', 'repo');

  const createdCount = oct._created.filter((n) => n === PROOF_NAME).length;
  createdCount === 1
    ? ok('Two calls to enableMandatoryCheck create only one ruleset (idempotent)')
    : fail(`Expected 1 creation, got ${createdCount}`);

  const allProofRulesets = oct._store.filter((r) => r.name === PROOF_NAME);
  allProofRulesets.length === 1
    ? ok('Store contains exactly one proof ruleset after two enable calls')
    : fail(`Expected 1 proof ruleset in store, found ${allProofRulesets.length}`);
}

section('M3: enableMandatoryCheck — does not create when ruleset already exists');
{
  const oct = makeMockOctokit([makeRuleset(99, PROOF_NAME)]);
  await enableMandatoryCheck(oct, 'acme', 'repo');
  oct._created.length === 0
    ? ok('No new ruleset created when one already exists')
    : fail(`Expected 0 creates, got ${oct._created.length}`);
}

section('M3: enableMandatoryCheck — does not touch other rulesets');
{
  const oct = makeMockOctokit([
    makeRuleset(1, 'branch-protection-v1'),
    makeRuleset(2, 'require-signed-commits'),
  ]);
  await enableMandatoryCheck(oct, 'acme', 'repo');
  const store = oct._store;
  store.some((r) => r.name === 'branch-protection-v1')
    ? ok('Other ruleset "branch-protection-v1" untouched')
    : fail('Other ruleset was removed!');
  store.some((r) => r.name === 'require-signed-commits')
    ? ok('Other ruleset "require-signed-commits" untouched')
    : fail('Other ruleset was removed!');
}

// ── M3: disableMandatoryCheck ─────────────────────────────────────────────────

section('M3: disableMandatoryCheck — no-op when ruleset is absent');
{
  const oct = makeMockOctokit([]);
  await disableMandatoryCheck(oct, 'acme', 'repo'); // Should not throw
  oct._deleted.length === 0
    ? ok('No deletion when proof ruleset is absent (idempotent)')
    : fail(`Expected 0 deletions, got ${oct._deleted.length}`);
}

section('M3: disableMandatoryCheck — deletes the proof ruleset when present');
{
  const oct = makeMockOctokit([makeRuleset(55, PROOF_NAME)]);
  await disableMandatoryCheck(oct, 'acme', 'repo');
  const present = await getProofRuleset(oct, 'acme', 'repo');
  present === null
    ? ok('Proof ruleset deleted successfully')
    : fail('Proof ruleset should have been deleted');
  oct._deleted.includes(55)
    ? ok('Deleted by the correct ruleset ID (not by name alone)')
    : fail(`Expected id=55 in deleted list, got ${JSON.stringify(oct._deleted)}`);
}

section('M3: disableMandatoryCheck — does not touch other rulesets');
{
  const oct = makeMockOctokit([
    makeRuleset(1, 'branch-protection-v1'),
    makeRuleset(2, PROOF_NAME),
    makeRuleset(3, 'require-signed-commits'),
  ]);
  await disableMandatoryCheck(oct, 'acme', 'repo');
  const store = oct._store;
  store.some((r) => r.name === 'branch-protection-v1')
    ? ok('Other ruleset "branch-protection-v1" untouched after disable')
    : fail('Other ruleset was unexpectedly removed!');
  store.some((r) => r.name === 'require-signed-commits')
    ? ok('Other ruleset "require-signed-commits" untouched after disable')
    : fail('Other ruleset was unexpectedly removed!');
}

section('M3: disableMandatoryCheck — idempotent (two calls when present → one deletion)');
{
  const oct = makeMockOctokit([makeRuleset(77, PROOF_NAME)]);
  await disableMandatoryCheck(oct, 'acme', 'repo');
  await disableMandatoryCheck(oct, 'acme', 'repo');
  oct._deleted.length === 1
    ? ok('Two disable calls produce only one deletion (idempotent)')
    : fail(`Expected 1 deletion, got ${oct._deleted.length}`);
}

section('M3: enable → disable → enable lifecycle');
{
  const oct = makeMockOctokit([]);
  await enableMandatoryCheck(oct, 'acme', 'repo');
  const afterEnable = await getProofRuleset(oct, 'acme', 'repo');
  afterEnable !== null
    ? ok('Ruleset present after enable')
    : fail('Ruleset should be present after enable');

  await disableMandatoryCheck(oct, 'acme', 'repo');
  const afterDisable = await getProofRuleset(oct, 'acme', 'repo');
  afterDisable === null
    ? ok('Ruleset absent after disable')
    : fail('Ruleset should be absent after disable');

  await enableMandatoryCheck(oct, 'acme', 'repo');
  const afterReEnable = await getProofRuleset(oct, 'acme', 'repo');
  afterReEnable !== null
    ? ok('Ruleset present again after re-enable')
    : fail('Ruleset should be present after re-enable');
}

process.exit(summary('M3 Rulesets Tests'));
