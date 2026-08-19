/**
 * src/lib/proofActions.js
 *
 * Shared PRoof action functions, callable from BOTH the comment webhook
 * handler AND the web dashboard (Server Actions).
 *
 * These functions have NO knowledge of whether the caller is a webhook
 * handler or a web request — they take structured arguments and return
 * structured data. Comment formatting and HTTP handling are the caller's
 * responsibility.
 *
 * All functions re-check the admin permission themselves when relevant —
 * callers are responsible for ensuring they pass the correct actorLogin.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { enableMandatoryCheck, disableMandatoryCheck } from "./rulesets.js";

// ── Prisma singleton ──────────────────────────────────────────────────────────

const globalForPrisma = globalThis;
if (!globalForPrisma.prismaActions) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  globalForPrisma.prismaActions = new PrismaClient({ adapter });
}
const prisma = globalForPrisma.prismaActions;

// ── Action: setMandatory ──────────────────────────────────────────────────────

/**
 * Enable or disable the PRoof mandatory check on a repo.
 *
 * Manages both the GitHub Ruleset and the RepoSettings DB row atomically.
 * Idempotent in both directions.
 *
 * @param {object} params
 * @param {import('octokit').Octokit} params.octokit  App installation Octokit.
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.actorLogin  GitHub login of the person authorizing this change.
 * @param {boolean} params.enabled    true = enable mandatory, false = disable.
 * @returns {Promise<{ mandatory: boolean, repoFullName: string }>}
 */
export async function setMandatory({ octokit, owner, repo, actorLogin, enabled }) {
  const fullName = `${owner}/${repo}`;

  if (enabled) {
    await enableMandatoryCheck(octokit, owner, repo);
  } else {
    await disableMandatoryCheck(octokit, owner, repo);
  }

  await prisma.repoSettings.upsert({
    where: { repoFullName: fullName },
    update: { mandatory: enabled, updatedBy: actorLogin },
    create: { repoFullName: fullName, mandatory: enabled, updatedBy: actorLogin },
  });

  return { mandatory: enabled, repoFullName: fullName };
}

// ── Action: getReport ─────────────────────────────────────────────────────────

/**
 * Aggregate all confidence receipts for a repo.
 *
 * Returns structured data — no markdown formatting, no HTTP calls.
 * The caller decides how to present the data (comment vs web page).
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @returns {Promise<{
 *   repoFullName: string,
 *   totalReceipts: number,
 *   byUser: Array<{
 *     login: string,
 *     count: number,
 *     avg: number,
 *     successes: number,
 *     failures: number,
 *     scores: number[]
 *   }>
 * }>}
 */
export async function getReport({ owner, repo }) {
  const fullName = `${owner}/${repo}`;

  const receipts = await prisma.receipt.findMany({
    where: { repoFullName: fullName },
    include: { user: true },
    orderBy: { timestamp: "desc" },
  });

  const byUserMap = {};
  for (const r of receipts) {
    const login = r.user?.login ?? r.userId;
    if (!byUserMap[login]) {
      byUserMap[login] = { login, scores: [], outcomes: [] };
    }
    byUserMap[login].scores.push(r.confidence);
    if (r.outcome) byUserMap[login].outcomes.push(r.outcome);
  }

  const byUser = Object.values(byUserMap).map((u) => ({
    login: u.login,
    count: u.scores.length,
    avg: u.scores.length > 0
      ? u.scores.reduce((a, b) => a + b, 0) / u.scores.length
      : 0,
    successes: u.outcomes.filter((o) => o === "SUCCESS").length,
    failures:  u.outcomes.filter((o) => o === "FAILURE").length,
    scores: u.scores,
  })).sort((a, b) => b.count - a.count);

  return {
    repoFullName: fullName,
    totalReceipts: receipts.length,
    byUser,
  };
}

// ── Action: getUserHistory ────────────────────────────────────────────────────

/**
 * Get confidence history for a single user on a repo.
 * Used for the non-admin dashboard view (only their own data).
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.userLogin  GitHub login of the user.
 * @returns {Promise<Array<{ prNumber, confidence, outcome, timestamp }>>}
 */
export async function getUserHistory({ owner, repo, userLogin }) {
  const fullName = `${owner}/${repo}`;

  const receipts = await prisma.receipt.findMany({
    where: { repoFullName: fullName, userId: userLogin },
    orderBy: { timestamp: "desc" },
    select: {
      prNumber: true,
      confidence: true,
      outcome: true,
      timestamp: true,
      sha: true,
    },
  });

  return receipts;
}

// ── Action: getRepoSettings ───────────────────────────────────────────────────

/**
 * Get the current PRoof settings for a repo.
 * Returns { mandatory: false } if no settings row exists yet.
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @returns {Promise<{ repoFullName: string, mandatory: boolean, updatedBy: string|null }>}
 */
export async function getRepoSettings({ owner, repo }) {
  const fullName = `${owner}/${repo}`;
  const settings = await prisma.repoSettings.findUnique({
    where: { repoFullName: fullName },
  });
  return settings ?? { repoFullName: fullName, mandatory: false, updatedBy: null };
}
