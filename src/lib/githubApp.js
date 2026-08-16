import { Octokit } from "octokit";

/**
 * In a real GitHub App, you'd use @octokit/auth-app to generate an
 * installation token. For this demo/v2, if an installation token isn't
 * available, we can fallback to a personal access token for testing.
 */
export async function getOctokit(installationId) {
  // Demo fallback to standard token if no GitHub App private key is provided
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.warn("No GITHUB_TOKEN or App Auth found.");
  }

  return new Octokit({ auth: token });
}

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
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }
}
