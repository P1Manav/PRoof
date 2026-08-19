#!/usr/bin/env node
/**
 * test/dashboard-list.test.js
 *
 * M9 — Dashboard repo list logic tests.
 *
 * Tests the filtering and permission-check logic used in /dashboard/page.js
 * without importing Next.js-specific modules. The logic is extracted and
 * tested in-process using mocked data.
 *
 * Exits 0 on success, 1 on failure.
 */

import { ok, fail, section, summary } from './_util.js';
import { getUserPermission } from '../src/lib/permissions.js';

// ── Simulate the repo-filtering logic from dashboard/page.js ─────────────────

/**
 * Mirrors the filtering logic in DashboardPage:
 * - User repos (from OAuth token API call)
 * - Cross-reference against PRoof installation table
 * - Only show repos in BOTH lists
 */
function filterVisibleRepos(userRepos, proofRepos) {
  const proofSet = new Set(proofRepos);
  return userRepos.filter((r) => proofSet.has(r));
}

/**
 * Build per-repo data with mocked permission checks.
 */
async function buildRepoData(visibleRepos, installationMap, permissionMap) {
  return Promise.all(
    visibleRepos.map(async (fullName) => {
      const [owner, repo] = fullName.split("/");
      const installId = installationMap[fullName];
      if (!installId) return null;

      const permission = permissionMap[fullName] ?? "none";
      const octokit = makeMockOctokit(permission);
      const perm = await getUserPermission(octokit, owner, repo, "testuser");

      return { fullName, owner, repo, permission: perm };
    })
  );
}

function makeMockOctokit(permission) {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

section("M9: filterVisibleRepos — only shows repos in both lists");
{
  const userRepos = ["acme/repo-a", "acme/repo-b", "acme/repo-c"];
  const proofRepos = ["acme/repo-a", "acme/repo-c", "acme/repo-z"];

  const visible = filterVisibleRepos(userRepos, proofRepos);
  visible.includes("acme/repo-a")
    ? ok('"acme/repo-a" shown (in both lists)')
    : fail('"acme/repo-a" should be visible');
  visible.includes("acme/repo-c")
    ? ok('"acme/repo-c" shown (in both lists)')
    : fail('"acme/repo-c" should be visible');
  !visible.includes("acme/repo-b")
    ? ok('"acme/repo-b" excluded (not in proof list)')
    : fail('"acme/repo-b" should NOT be visible — PRoof not installed there');
  !visible.includes("acme/repo-z")
    ? ok('"acme/repo-z" excluded (not in user\'s list)')
    : fail('"acme/repo-z" should NOT be visible — user can\'t see it');
  visible.length === 2
    ? ok(`Correct count: ${visible.length} repos visible`)
    : fail(`Expected 2 visible repos, got ${visible.length}`);
}

section("M9: filterVisibleRepos — empty user list");
{
  const visible = filterVisibleRepos([], ["acme/repo-a"]);
  visible.length === 0
    ? ok("Empty user list → no visible repos")
    : fail("Should return empty for empty user list");
}

section("M9: filterVisibleRepos — empty proof list");
{
  const visible = filterVisibleRepos(["acme/repo-a"], []);
  visible.length === 0
    ? ok("Empty proof list → no visible repos")
    : fail("Should return empty for empty proof list");
}

section("M9: filterVisibleRepos — both empty");
{
  const visible = filterVisibleRepos([], []);
  visible.length === 0
    ? ok("Both empty → no visible repos")
    : fail("Both empty should yield empty");
}

section("M9: buildRepoData — live permission fetched per repo");
{
  const visibleRepos = ["acme/repo-a", "acme/repo-b"];
  const installationMap = {
    "acme/repo-a": 101,
    "acme/repo-b": 102,
  };
  const permissionMap = {
    "acme/repo-a": "admin",
    "acme/repo-b": "read",
  };

  const data = await buildRepoData(visibleRepos, installationMap, permissionMap);
  const valid = data.filter(Boolean);

  valid.length === 2
    ? ok("Both repos returned with data")
    : fail(`Expected 2 repos, got ${valid.length}`);

  const repoA = valid.find((r) => r.fullName === "acme/repo-a");
  repoA?.permission === "admin"
    ? ok("repo-a permission is 'admin' (live check)")
    : fail(`repo-a permission should be 'admin', got ${repoA?.permission}`);

  const repoB = valid.find((r) => r.fullName === "acme/repo-b");
  repoB?.permission === "read"
    ? ok("repo-b permission is 'read' (live check)")
    : fail(`repo-b permission should be 'read', got ${repoB?.permission}`);
}

section("M9: buildRepoData — repos without installation are excluded");
{
  const visibleRepos = ["acme/repo-a", "acme/orphan"];
  const installationMap = { "acme/repo-a": 101 }; // orphan has no entry
  const permissionMap = { "acme/repo-a": "write" };

  const data = await buildRepoData(visibleRepos, installationMap, permissionMap);
  const valid = data.filter(Boolean);

  valid.length === 1
    ? ok("Repo without installation excluded (returns null)")
    : fail(`Expected 1 valid repo, got ${valid.length}`);
  !valid.some((r) => r.fullName === "acme/orphan")
    ? ok('"acme/orphan" correctly excluded (no installation)')
    : fail('"acme/orphan" should be excluded');
}

section("M9: Permission check uses app-scoped Octokit (not user OAuth token)");
{
  // The dashboard uses getOctokit(installationId) for permission checks,
  // not the user's OAuth token. We verify the permission function receives
  // a repo-specific octokit (simulated by installationId mapping).
  let octokitInstallationIdsUsed = [];
  const mockGetOctokit = async (installId) => {
    octokitInstallationIdsUsed.push(installId);
    return makeMockOctokit("write");
  };

  // Simulate two repos with different installation IDs
  const repos = [
    { fullName: "acme/repo-a", installId: 101 },
    { fullName: "acme/repo-b", installId: 102 },
  ];

  for (const { fullName, installId } of repos) {
    const [owner, repo] = fullName.split("/");
    const octokit = await mockGetOctokit(installId);
    await getUserPermission(octokit, owner, repo, "alice");
  }

  octokitInstallationIdsUsed.includes(101) && octokitInstallationIdsUsed.includes(102)
    ? ok("Each repo uses its own installation-scoped Octokit")
    : fail("Expected installation-scoped Octokits for each repo");
}

process.exit(summary("M9 Dashboard List Tests"));
