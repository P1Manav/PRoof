import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

/**
 * Normalize a private key string that may have literal "\n" sequences
 * instead of real newlines (common when pasting PEM content into Vercel
 * environment variable fields).
 */
function normalizePrivateKey(raw) {
  // If the key already contains real newlines, return as-is.
  if (raw.includes("\n")) return raw;
  // Replace escaped newlines with real newlines.
  return raw.replace(/\\n/g, "\n");
}

/**
 * Return an authenticated Octokit instance for the given GitHub App
 * installation.
 *
 * Production path: uses @octokit/auth-app to mint a fresh installation
 * token scoped to `installationId`.
 *
 * Local dev path (NODE_ENV !== 'production'): falls back to GITHUB_TOKEN
 * so you can test against your own repo without a registered App.
 *
 * @param {number|undefined} installationId  GitHub installation ID from the webhook payload.
 */
export async function getOctokit(installationId) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;

  if (process.env.NODE_ENV !== "production" && !appId) {
    // Local dev fallback — never used in production.
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.warn("[PRoof] No GITHUB_TOKEN or App credentials found. API calls will fail.");
    }
    return new Octokit({ auth: token });
  }

  if (!appId || !privateKeyRaw) {
    throw new Error(
      "[PRoof] GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set in production."
    );
  }

  const privateKey = normalizePrivateKey(privateKeyRaw);

  const auth = createAppAuth({
    appId: Number(appId),
    privateKey,
    installationId,
  });

  // Authenticate as the installation (scoped token).
  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

/**
 * Post a new comment or update the existing bot comment (identified by
 * `marker`) on a PR/issue. Returns the comment ID (number).
 *
 * @param {Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} marker  Unique HTML comment string embedded in the bot comment body.
 * @param {string} body
 * @returns {Promise<number>} The GitHub comment ID.
 */
export async function postOrUpdateComment(octokit, owner, repo, issueNumber, marker, body) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const existing = comments.find((c) => c.body.includes(marker));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return existing.id;
  } else {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  }
}
