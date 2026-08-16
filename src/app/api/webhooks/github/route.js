import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getOctokit, postOrUpdateComment } from "@/lib/githubApp";
import { judgeDescription } from "@/lib/gemini";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const MARKER = "<!-- proof-bot-v2 -->";

export async function POST(req) {
  const event = req.headers.get("x-github-event");
  const payload = await req.json();

  if (event === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) {
    await handlePullRequest(payload);
  } else if (event === "pull_request" && payload.action === "closed") {
    await handlePullRequestClosed(payload);
  } else if (event === "check_run" && payload.action === "completed") {
    await handleCheckRunCompleted(payload);
  }

  return NextResponse.json({ success: true });
}

async function handlePullRequest(payload) {
  const { pull_request: pr, repository: repo, installation } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const fullName = repo.full_name;

  const octokit = await getOctokit(installation?.id);

  // 1. Fetch commits
  const { data: commits } = await octokit.rest.pulls.listCommits({
    owner,
    repo: repoName,
    pull_number: pr.number,
  });

  // 2. Fetch receipts/notes for each commit
  const shas = commits.map(c => c.sha);
  const receipts = await prisma.receipt.findMany({
    where: { sha: { in: shas }, repoFullName: fullName }
  });

  const lowestConfidence = receipts.length > 0 
    ? Math.min(...receipts.map(r => r.confidence)) 
    : null;

  // 3. Diff stat vs Description via Gemini
  const diffStat = `Commits: ${commits.length}, Additions: ${pr.additions}, Deletions: ${pr.deletions}, Changed Files: ${pr.changed_files}`;
  const aiAssessment = await judgeDescription(pr.body, diffStat);

  // 4. Post Comment
  const confText = lowestConfidence !== null 
    ? `${lowestConfidence}/10` 
    : `no scores recorded`;

  const body = `${MARKER}
## 🧾 PRoof — PR Audit (v2)

⬜ **Lowest confidence score in this PR:** ${confText}

---

### Description vs diff
${aiAssessment.covered ? "✅" : "❌"} ${aiAssessment.reasoning}

---

<sub>PRoof bot v2 • [What is this?](https://github.com/P1Manav/PRoof)</sub>
`;

  await postOrUpdateComment(octokit, owner, repoName, pr.number, MARKER, body);
}

async function handlePullRequestClosed(payload) {
  const { pull_request: pr, repository: repo, installation } = payload;
  const isMerged = pr.merged;
  
  if (isMerged) {
    // Merged cleanly, mark success in DB.
    await prisma.receipt.updateMany({
      where: { prNumber: pr.number, repoFullName: repo.full_name },
      data: { outcome: "SUCCESS" }
    });
  } else {
    // Closed unmerged / rejected
    await prisma.receipt.updateMany({
      where: { prNumber: pr.number, repoFullName: repo.full_name },
      data: { outcome: "FAILURE" }
    });

    // Post roast comment for the highest confident claim that failed
    const receipts = await prisma.receipt.findMany({
      where: { prNumber: pr.number, repoFullName: repo.full_name },
      orderBy: { confidence: 'desc' },
      include: { user: true }
    });

    if (receipts.length > 0) {
      const topReceipt = receipts[0];
      if (topReceipt.confidence >= 7) {
        const octokit = await getOctokit(installation?.id);
        const roastBody = `### 🧾 PRoof Receipt Follow-up\n\n@${topReceipt.user.login} logged **${topReceipt.confidence}/10 confidence** on this code, but the PR was closed unmerged! 😬\n\n> *The code speaks for itself... or doesn't.*`;
        await octokit.rest.issues.createComment({
          owner: repo.owner.login,
          repo: repo.name,
          issue_number: pr.number,
          body: roastBody,
        });
      }
    }
  }
}

async function handleCheckRunCompleted(payload) {
  const { check_run, repository: repo, installation } = payload;
  if (check_run.conclusion !== "failure") return;

  // Check run failed. Find associated pull requests.
  const prs = check_run.pull_requests;
  if (!prs || prs.length === 0) return;

  const octokit = await getOctokit(installation?.id);

  for (const pr of prs) {
    const receipts = await prisma.receipt.findMany({
      where: { prNumber: pr.number, repoFullName: repo.full_name },
      orderBy: { confidence: 'desc' },
      include: { user: true }
    });

    if (receipts.length > 0) {
      const topReceipt = receipts[0];
      if (topReceipt.confidence >= 7) {
        const roastBody = `### 🧾 PRoof Receipt Follow-up\n\n@${topReceipt.user.login} logged **${topReceipt.confidence}/10 confidence** for this code, but CI just failed (\`${check_run.name}\`)! 🚨\n\n> *Confidence is quiet, but CI failures are loud.*`;
        
        await octokit.rest.issues.createComment({
          owner: repo.owner.login,
          repo: repo.name,
          issue_number: pr.number,
          body: roastBody,
        });

        // Mark receipts as failed
        await prisma.receipt.updateMany({
          where: { prNumber: pr.number, repoFullName: repo.full_name },
          data: { outcome: "FAILURE" }
        });
      }
    }
  }
}
