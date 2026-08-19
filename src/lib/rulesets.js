/**
 * src/lib/rulesets.js
 *
 * Manage the PRoof-owned GitHub Ruleset: "proof-confidence-required".
 *
 * Design constraints (locked in by the project spec):
 * - PRoof owns exactly ONE ruleset, identified by name = "proof-confidence-required".
 * - Never creates, modifies, or deletes any other ruleset on the repo.
 * - enableMandatoryCheck is idempotent — two calls produce one ruleset.
 * - disableMandatoryCheck is idempotent — no-op if the ruleset is absent.
 * - No bypass actors.
 * - Target: default branch only.
 */

const RULESET_NAME = "proof-confidence-required";
const STATUS_CONTEXT = "PRoof Confidence";

/**
 * Find the PRoof ruleset on a repo.
 *
 * Lists all rulesets and returns the one named exactly "proof-confidence-required",
 * or null if absent. Never touches or returns any other ruleset.
 *
 * @param {import('octokit').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<object|null>}  The ruleset object if found, null otherwise.
 */
export async function getProofRuleset(octokit, owner, repo) {
  // GitHub paginates rulesets — loop until we've checked all pages.
  let page = 1;
  while (true) {
    const { data: rulesets } = await octokit.rest.repos.getRepoRulesets({
      owner,
      repo,
      per_page: 100,
      page,
    });

    if (!rulesets || rulesets.length === 0) return null;

    const found = rulesets.find((r) => r.name === RULESET_NAME);
    if (found) return found;

    // If we got a full page, there may be more.
    if (rulesets.length < 100) return null;
    page++;
  }
}

/**
 * Enable the PRoof mandatory check by creating the dedicated ruleset.
 * Idempotent: if the ruleset already exists, does nothing.
 *
 * @param {import('octokit').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<void>}
 */
export async function enableMandatoryCheck(octokit, owner, repo) {
  // Idempotency check — do not create a second ruleset.
  const existing = await getProofRuleset(octokit, owner, repo);
  if (existing) return;

  // Fetch the default branch so we can scope the ruleset correctly.
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch;

  await octokit.rest.repos.createRepoRuleset({
    owner,
    repo,
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: STATUS_CONTEXT },
          ],
          strict_required_status_checks_policy: false,
        },
      },
    ],
    // No bypass_actors — intentional per spec.
  });
}

/**
 * Disable the PRoof mandatory check by deleting the dedicated ruleset.
 * Idempotent: if the ruleset is absent, does nothing.
 *
 * @param {import('octokit').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<void>}
 */
export async function disableMandatoryCheck(octokit, owner, repo) {
  const existing = await getProofRuleset(octokit, owner, repo);
  if (!existing) return;

  await octokit.rest.repos.deleteRepoRuleset({
    owner,
    repo,
    ruleset_id: existing.id,
  });
}
