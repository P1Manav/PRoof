"use server";

/**
 * src/app/dashboard/[owner]/[repo]/actions.js
 *
 * Server Actions for the per-repo dashboard view.
 *
 * Each action:
 * 1. Re-verifies the session (not trusted from client or earlier in same page load)
 * 2. Re-checks live admin permission for THIS repo (not reused from the list page)
 * 3. Delegates to proofActions.js for the actual business logic
 *
 * Next.js Server Actions provide built-in origin/CSRF protection — no raw
 * API route needed for these mutations.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOctokit } from "@/lib/githubApp";
import { isAdmin } from "@/lib/permissions";
import { setMandatory } from "@/lib/proofActions";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// ── Prisma singleton ──────────────────────────────────────────────────────────
const globalForPrisma = globalThis;
if (!globalForPrisma.prismaActions2) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  globalForPrisma.prismaActions2 = new PrismaClient({ adapter });
}
const prisma = globalForPrisma.prismaActions2;

// ── Helper: resolve installation ID for a repo ────────────────────────────────

async function getInstallationId(owner, repo) {
  const fullName = `${owner}/${repo}`;
  const installation = await prisma.installation.findFirst({
    where: { repos: { has: fullName } },
    select: { id: true },
  });
  return installation?.id ?? undefined;
}

// ── Action: toggleMandatory ───────────────────────────────────────────────────

/**
 * Toggle the PRoof mandatory enforcement for a repo.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {boolean} enabled
 */
export async function toggleMandatory(owner, repo, enabled) {
  // 1. Verify session — re-checked here, never trusted from client
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const actorLogin = session.user?.login ?? session.user?.name;

  // 2. Resolve installation ID for this repo
  const installationId = await getInstallationId(owner, repo);
  if (!installationId) {
    throw new Error(`PRoof is not installed on ${owner}/${repo}`);
  }

  // 3. Re-check live admin permission for THIS repo — never reuse cached value
  const octokit = await getOctokit(installationId);
  const adminCheck = await isAdmin(octokit, owner, repo, actorLogin);
  if (!adminCheck) {
    throw new Error("Only repo admins can change PRoof's merge requirements.");
  }

  // 4. Delegate to shared action
  return await setMandatory({ octokit, owner, repo, actorLogin, enabled });
}
