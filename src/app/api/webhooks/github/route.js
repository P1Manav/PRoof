import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createHmac, timingSafeEqual } from "crypto";
import { getOctokit, postOrUpdateComment } from "@/lib/githubApp";
import { judgeDescription } from "@/lib/gemini";

// ── Markers ───────────────────────────────────────────────────────────────────

const AUDIT_MARKER = "<!-- proof-bot-v2 -->";
const CONFIDENCE_MARKER = "<!-- proof-confidence-prompt -->";

// ── Prisma singleton ──────────────────────────────────────────────────────────

const globalForPrisma = globalThis;
if (!globalForPrisma.prisma) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  globalForPrisma.prisma = new PrismaClient({ adapter });
}
const prisma = globalForPrisma.prisma;

// ── Webhook signature verification ────────────────────────────────────────────

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 * Returns true if the signature matches; false otherwise.
 * Must be called BEFORE any JSON parsing so the raw bytes are intact.
 */
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // If no secret is configured, allow in dev but warn loudly.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[PRoof] GITHUB_WEBHOOK_SECRET not set — skipping signature check (dev only).");
      return true;
    }
    return false;
  }

  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signatureHeader, "utf8")
    );
  } catch {
    // Buffers differ in length — timingSafeEqual throws.
    return false;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function POST(req) {
  // Read raw body first (required for HMAC verification).
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-hub-signature-256");

  if (!verifySignature(rawBody, signatureHeader)) {
    console.warn("[PRoof] Rejected webhook — signature verification failed.");
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const event = req.headers.get("x-github-event");

  try {
    if (event === "installation") {
      await handleInstallation(payload);
    } else if (event === "pull_request") {
      if (payload.action === "opened") {
        await handlePullRequestOpened(payload);
      } else if (payload.action === "synchronize") {
        await handlePullRequestSynchronize(payload);
      } else if (payload.action === "closed") {
        await handlePullRequestClosed(payload);
      }
    } else if (event === "issue_comment" && payload.action === "created") {
      await handleIssueCommentCreated(payload);
    } else if (event === "check_run" && payload.action === "completed") {
      await handleCheckRunCompleted(payload);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[PRoof] Webhook processing error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// ── Installation handler ──────────────────────────────────────────────────────

async function handleInstallation(payload) {
  const { action, installation, repositories = [], repositories_added = [], repositories_removed = [] } = payload;

  const id = installation.id;
  const appId = installation.app_id;
  const accountLogin = installation.account.login;

  if (action === "created") {
    const repos = repositories.map((r) => r.full_name);
    await prisma.installation.upsert({
      where: { id },
      update: { repos, accountLogin, updatedAt: new Date() },
      create: { id, appId, accountLogin, repos },
    });
    console.log(`[PRoof] Installation ${id} created for ${accountLogin} covering: ${repos.join(", ")}`);
  } else if (action === "deleted") {
    await prisma.installation.deleteMany({ where: { id } });
    console.log(`[PRoof] Installation ${id} deleted for ${accountLogin}`);
  } else if (action === "added") {
    // Repos added to an existing installation.
    const added = repositories_added.map((r) => r.full_name);
    const existing = await prisma.installation.findUnique({ where: { id } });
    if (existing) {
      const merged = Array.from(new Set([...existing.repos, ...added]));
      await prisma.installation.update({ where: { id }, data: { repos: merged } });
    }
    console.log(`[PRoof] Installation ${id}: added repos ${added.join(", ")}`);
  } else if (action === "removed") {
    const removed = repositories_removed.map((r) => r.full_name);
    const existing = await prisma.installation.findUnique({ where: { id } });
    if (existing) {
      const trimmed = existing.repos.filter((r) => !removed.includes(r));
      await prisma.installation.update({ where: { id }, data: { repos: trimmed } });
    }
    console.log(`[PRoof] Installation ${id}: removed repos ${removed.join(", ")}`);
  }
}

// ── PR opened ────────────────────────────────────────────────────────────────

async function handlePullRequestOpened(payload) {
  const { pull_request: pr, repository: repo, installation } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const fullName = repo.full_name;

  const octokit = await getOctokit(installation?.id);

  // 1. Post confidence prompt comment (one per PR).
  const promptBody = buildConfidencePromptBody(pr);
  const commentId = await postOrUpdateComment(
    octokit,
    owner,
    repoName,
    pr.number,
    CONFIDENCE_MARKER,
    promptBody
  );

  // 2. Store (or reset) the ConfidencePrompt tracking row.
  await prisma.confidencePrompt.upsert({
    where: { repoFullName_prNumber: { repoFullName: fullName, prNumber: pr.number } },
    update: { commentId: BigInt(commentId), answered: false },
    create: { repoFullName: fullName, prNumber: pr.number, commentId: BigInt(commentId) },
  });

  // 3. Fetch commits for audit.
  const { data: commits } = await octokit.rest.pulls.listCommits({
    owner,
    repo: repoName,
    pull_number: pr.number,
  });

  // 4. Fetch any existing receipts (from git-notes hook).
  const shas = commits.map((c) => c.sha);
  const receipts = await prisma.receipt.findMany({
    where: { sha: { in: shas }, repoFullName: fullName },
  });

  const lowestConfidence =
    receipts.length > 0 ? Math.min(...receipts.map((r) => r.confidence)) : null;

  // 5. AI description audit.
  const diffStat = `Commits: ${commits.length}, Additions: ${pr.additions ?? "?"}, Deletions: ${pr.deletions ?? "?"}, Changed Files: ${pr.changed_files ?? "?"}`;
  const aiAssessment = await judgeDescription(pr.body, diffStat);

  // 6. Post or update audit comment.
  const confText =
    lowestConfidence !== null ? `${lowestConfidence}/10` : "no scores recorded yet";
  const auditBody = buildAuditCommentBody(confText, aiAssessment);
  await postOrUpdateComment(octokit, owner, repoName, pr.number, AUDIT_MARKER, auditBody);
}

// ── PR synchronize ────────────────────────────────────────────────────────────

async function handlePullRequestSynchronize(payload) {
  const { pull_request: pr, repository: repo, installation } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const fullName = repo.full_name;

  const existing = await prisma.confidencePrompt.findUnique({
    where: { repoFullName_prNumber: { repoFullName: fullName, prNumber: pr.number } },
  });

  if (!existing) {
    // No prompt exists yet — treat as if the PR just opened.
    await handlePullRequestOpened(payload);
    return;
  }

  if (existing.answered) {
    // New commits after an answer was logged — re-open the prompt.
    const octokit = await getOctokit(installation?.id);
    const reopenBody = buildConfidencePromptBody(pr, /* reopen */ true);
    const commentId = await postOrUpdateComment(
      octokit,
      owner,
      repoName,
      pr.number,
      CONFIDENCE_MARKER,
      reopenBody
    );
    await prisma.confidencePrompt.update({
      where: { repoFullName_prNumber: { repoFullName: fullName, prNumber: pr.number } },
      data: { answered: false, commentId: BigInt(commentId) },
    });
  }
  // If not yet answered — do nothing; the original prompt still stands.
}

// ── issue_comment created ─────────────────────────────────────────────────────

async function handleIssueCommentCreated(payload) {
  const { comment, issue, repository: repo, installation } = payload;

  // issue_comment fires for both issues and PRs; GitHub marks PRs with pull_request.
  if (!issue.pull_request) return;

  const fullName = repo.full_name;
  const prNumber = issue.number;
  const commenterLogin = comment.user.login;

  // Don't react to our own bot comments.
  // (Bot comments contain our marker strings.)
  if (
    comment.body.includes(CONFIDENCE_MARKER) ||
    comment.body.includes(AUDIT_MARKER)
  ) {
    return;
  }

  // Look up the open confidence prompt for this PR.
  const prompt = await prisma.confidencePrompt.findUnique({
    where: { repoFullName_prNumber: { repoFullName: fullName, prNumber } },
  });
  if (!prompt || prompt.answered) return;

  // Parse confidence score from the comment body.
  const score = parseConfidenceScore(comment.body);
  if (score === null) return; // Silently ignore non-matching replies.

  const octokit = await getOctokit(installation?.id);

  // Fetch the PR to get the HEAD commit SHA.
  const owner = repo.owner.login;
  const repoName = repo.name;
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });
  const headSha = pr.head.sha;

  // Upsert the Receipt. Use the comment-path unique key (repoFullName, prNumber, userId).
  // Ensure the User row exists first.
  await prisma.user.upsert({
    where: { id: commenterLogin },
    update: {},
    create: {
      id: commenterLogin,
      login: commenterLogin,
      avatarUrl: comment.user.avatar_url ?? null,
    },
  });

  await prisma.receipt.upsert({
    where: {
      repoFullName_prNumber_userId: {
        repoFullName: fullName,
        prNumber,
        userId: commenterLogin,
      },
    },
    update: {
      confidence: score,
      sha: headSha,
      source: "comment",
      commenter: commenterLogin,
    },
    create: {
      sha: headSha,
      prNumber,
      repoFullName: fullName,
      confidence: score,
      source: "comment",
      commenter: commenterLogin,
      userId: commenterLogin,
    },
  });

  // Mark prompt as answered.
  await prisma.confidencePrompt.update({
    where: { repoFullName_prNumber: { repoFullName: fullName, prNumber } },
    data: { answered: true },
  });

  // Add 👍 reaction to the comment (confirm receipt without posting a new comment).
  await octokit.rest.reactions.createForIssueComment({
    owner,
    repo: repoName,
    comment_id: comment.id,
    content: "+1",
  });
}

// ── PR closed ────────────────────────────────────────────────────────────────

async function handlePullRequestClosed(payload) {
  const { pull_request: pr, repository: repo, installation } = payload;
  const isMerged = pr.merged;
  const fullName = repo.full_name;

  const outcome = isMerged ? "SUCCESS" : "FAILURE";
  await prisma.receipt.updateMany({
    where: { prNumber: pr.number, repoFullName: fullName },
    data: { outcome },
  });

  if (!isMerged) {
    // Post receipt follow-up for the highest-confidence claim.
    const receipts = await prisma.receipt.findMany({
      where: { prNumber: pr.number, repoFullName: fullName },
      orderBy: { confidence: "desc" },
      include: { user: true },
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

// ── check_run completed ───────────────────────────────────────────────────────

async function handleCheckRunCompleted(payload) {
  const { check_run, repository: repo, installation } = payload;
  if (check_run.conclusion !== "failure") return;

  const prs = check_run.pull_requests;
  if (!prs || prs.length === 0) return;

  const fullName = repo.full_name;
  const octokit = await getOctokit(installation?.id);

  for (const pr of prs) {
    const receipts = await prisma.receipt.findMany({
      where: { prNumber: pr.number, repoFullName: fullName },
      orderBy: { confidence: "desc" },
      include: { user: true },
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

        await prisma.receipt.updateMany({
          where: { prNumber: pr.number, repoFullName: fullName },
          data: { outcome: "FAILURE" },
        });
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a confidence score (integer 1-10) from a comment body.
 * Accepts: "8", "8/10", "confidence: 8", "confidence:8" (case-insensitive).
 * Returns null if no valid score found.
 */
function parseConfidenceScore(body) {
  const text = body.trim();

  // Match patterns: "8", "8/10", "confidence: 8", "confidence:8"
  const patterns = [
    /^confidence\s*:\s*(\d+)/i,
    /^(\d+)\s*\/\s*10$/,
    /^(\d+)$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n >= 1 && n <= 10) return n;
    }
  }

  return null;
}

function buildConfidencePromptBody(pr, reopen = false) {
  const header = reopen
    ? "🔄 **PRoof — Confidence Re-check**\n\nNew commits were pushed. Please re-confirm your confidence in this PR."
    : "👋 **PRoof — Confidence Check**\n\nBefore this PR is merged, reply with your confidence that the code is correct.";

  return `${CONFIDENCE_MARKER}
${header}

**Reply with a number 1–10** (e.g. \`8\` or \`confidence: 8\`):
- **1–3** 🔴 Low — significant uncertainty
- **4–6** 🟡 Medium — fairly confident, some unknowns
- **7–9** 🟢 High — confident this is correct
- **10** ✅ Certain — fully reviewed and tested

> PRoof will follow up with a receipt if CI fails or the PR is closed without merging.

<sub>PRoof bot • [What is this?](https://github.com/P1Manav/PRoof)</sub>
`;
}

function buildAuditCommentBody(confText, aiAssessment) {
  return `${AUDIT_MARKER}
## 🧾 PRoof — PR Audit (v2)

⬜ **Lowest confidence score in this PR:** ${confText}

---

### Description vs diff
${aiAssessment.covered ? "✅" : "❌"} ${aiAssessment.reasoning}

---

<sub>PRoof bot v2 • [What is this?](https://github.com/P1Manav/PRoof)</sub>
`;
}
