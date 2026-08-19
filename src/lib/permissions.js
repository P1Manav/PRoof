/**
 * src/lib/permissions.js
 *
 * Live, uncached GitHub permission checks.
 *
 * Design constraints (locked in by the project spec):
 * - Always called fresh on every privileged action — no caching.
 * - isAdmin is true ONLY for the exact string "admin".
 * - Never trusts a permission from an earlier check in the same session.
 */

/**
 * Fetch the live collaboration permission level for a user on a repo.
 *
 * Calls GET /repos/{owner}/{repo}/collaborators/{username}/permission.
 *
 * @param {import('octokit').Octokit} octokit  Authenticated Octokit instance.
 * @param {string} owner
 * @param {string} repo
 * @param {string} username  GitHub login to check.
 * @returns {Promise<string>}  One of: "admin", "maintain", "write", "triage", "read", "none".
 *                             Returns "none" if the API returns 404 (not a collaborator).
 */
export async function getUserPermission(octokit, owner, repo, username) {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return data.permission;
  } catch (err) {
    // GitHub returns 404 when the user is not a collaborator at all.
    if (err.status === 404) return "none";
    throw err;
  }
}

/**
 * Returns true if and only if the live GitHub permission for `username` on
 * this repo is exactly "admin". All other tiers (maintain, write, triage,
 * read, none) return false.
 *
 * @param {import('octokit').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export async function isAdmin(octokit, owner, repo, username) {
  const permission = await getUserPermission(octokit, owner, repo, username);
  return permission === "admin";
}
