/**
 * src/app/dashboard/[owner]/[repo]/page.js
 *
 * M10 — Per-repo view.
 *
 * Behavior by permission tier (checked LIVE on every load):
 *   - No access (user can't see the repo at all) → notFound() [404, not 403]
 *   - Non-admin (has real repo access) → own confidence history only
 *   - Admin → mandatory toggle + full aggregate report + own history
 *
 * Critical: permission is re-checked here, NOT reused from the dashboard
 * list page. Force-dynamic ensures no caching.
 */

import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getOctokit } from "@/lib/githubApp";
import { getUserPermission } from "@/lib/permissions";
import { getReport, getUserHistory, getRepoSettings } from "@/lib/proofActions";
import { toggleMandatory } from "./actions";

export const dynamic = "force-dynamic";

// ── Prisma singleton ──────────────────────────────────────────────────────────
const globalForPrisma = globalThis;
if (!globalForPrisma.prismaRepo) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  globalForPrisma.prismaRepo = new PrismaClient({ adapter });
}
const prisma = globalForPrisma.prismaRepo;

// ── Metadata ──────────────────────────────────────────────────────────────────
export async function generateMetadata({ params }) {
  const { owner, repo } = await params;
  return {
    title: `${owner}/${repo} — PRoof Dashboard`,
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function RepoPage({ params }) {
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;

  // 1. Verify session — re-checked here regardless of proxy
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const userLogin = session.user?.login ?? session.user?.name;

  // 2. Resolve installation ID from DB (needed for app-scoped Octokit)
  const installation = await prisma.installation.findFirst({
    where: { repos: { has: fullName } },
    select: { id: true },
  });

  if (!installation) {
    // PRoof is not installed on this repo — treat as not found
    notFound();
  }

  // 3. Live permission check — fresh every page load, never reused
  let permission;
  try {
    const octokit = await getOctokit(installation.id);
    permission = await getUserPermission(octokit, owner, repo, userLogin);
  } catch {
    // Can't determine permission — 404 rather than 403 (don't reveal presence)
    notFound();
  }

  // 4. No access at all → 404 (spec: "not 403 — don't reveal PRoof's presence")
  if (permission === "none") {
    notFound();
  }

  const adminUser = permission === "admin";

  // 5. Fetch data based on permission tier
  const [settings, reportData, userHistory] = await Promise.all([
    adminUser ? getRepoSettings({ owner, repo }) : Promise.resolve(null),
    adminUser ? getReport({ owner, repo }) : Promise.resolve(null),
    getUserHistory({ owner, repo, userLogin }),
  ]);

  return (
    <main style={{ background: "#0b0f19", color: "#e2e8f0", minHeight: "100vh", fontFamily: "monospace", padding: "2rem" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: "2rem" }}>
          <a href="/dashboard" style={{ color: "#4a90d9", fontSize: "0.85rem", textDecoration: "none" }}>
            ← Dashboard
          </a>
          <h1 style={{ fontSize: "1.5rem", margin: "0.5rem 0 0.25rem" }}>
            {fullName}
          </h1>
          <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
            Your role: <PermissionBadge permission={permission} />
          </div>
        </div>

        {/* Admin section */}
        {adminUser && (
          <>
            <section style={{ marginBottom: "2rem", padding: "1.25rem", background: "#141922", border: "1px solid #2d3748", borderRadius: "0.5rem" }}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 1rem", color: "#f0f4f8" }}>
                🔧 Enforcement Settings
              </h2>
              <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <span style={{ color: "#94a3b8" }}>
                  Mandatory confidence check:{" "}
                  <strong style={{ color: settings?.mandatory ? "#68d391" : "#fc8181" }}>
                    {settings?.mandatory ? "ON" : "OFF"}
                  </strong>
                </span>

                {/* Toggle — Server Action form */}
                <form
                  action={async () => {
                    "use server";
                    await toggleMandatory(owner, repo, !settings?.mandatory);
                  }}
                >
                  <button
                    type="submit"
                    style={{
                      padding: "0.4rem 1rem",
                      background: settings?.mandatory ? "#742a2a" : "#1a4731",
                      color: "#fff",
                      border: "none",
                      borderRadius: "0.375rem",
                      cursor: "pointer",
                      fontFamily: "monospace",
                      fontSize: "0.85rem",
                    }}
                  >
                    {settings?.mandatory ? "Disable" : "Enable"}
                  </button>
                </form>
              </div>
              {settings?.updatedBy && (
                <p style={{ margin: "0.75rem 0 0", fontSize: "0.75rem", color: "#4a5568" }}>
                  Last updated by @{settings.updatedBy}
                </p>
              )}
            </section>

            {/* Aggregate report */}
            <section style={{ marginBottom: "2rem" }}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 1rem", color: "#f0f4f8" }}>
                📊 Aggregate Report
              </h2>
              {reportData && reportData.totalReceipts > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #2d3748" }}>
                        {["Contributor", "Scores", "Avg Confidence", "Successes", "Failures"].map((h) => (
                          <th key={h} style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: "#94a3b8", fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reportData.byUser.map((u) => (
                        <tr key={u.login} style={{ borderBottom: "1px solid #1a2233" }}>
                          <td style={{ padding: "0.5rem 0.75rem" }}>@{u.login}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{u.count}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{u.avg.toFixed(1)}/10</td>
                          <td style={{ padding: "0.5rem 0.75rem", color: "#68d391" }}>{u.successes}</td>
                          <td style={{ padding: "0.5rem 0.75rem", color: "#fc8181" }}>{u.failures}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: "0.75rem", color: "#4a5568", marginTop: "0.5rem" }}>
                    Total receipts: {reportData.totalReceipts}
                  </p>
                </div>
              ) : (
                <p style={{ color: "#94a3b8" }}>No confidence scores recorded yet.</p>
              )}
            </section>
          </>
        )}

        {/* Personal history — shown to everyone with access */}
        <section>
          <h2 style={{ fontSize: "1rem", margin: "0 0 1rem", color: "#f0f4f8" }}>
            📋 Your Confidence History
          </h2>
          {userHistory.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #2d3748" }}>
                    {["PR", "Confidence", "Outcome", "Date"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: "#94a3b8", fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {userHistory.map((r, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #1a2233" }}>
                      <td style={{ padding: "0.5rem 0.75rem" }}>
                        {r.prNumber ? (
                          <a href={`https://github.com/${fullName}/pull/${r.prNumber}`} style={{ color: "#4a90d9" }}>
                            #{r.prNumber}
                          </a>
                        ) : "—"}
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem" }}>{r.confidence}/10</td>
                      <td style={{ padding: "0.5rem 0.75rem" }}>
                        <OutcomeBadge outcome={r.outcome} />
                      </td>
                      <td style={{ padding: "0.5rem 0.75rem", color: "#94a3b8", fontSize: "0.75rem" }}>
                        {new Date(r.timestamp).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ color: "#94a3b8" }}>You haven't logged any confidence scores on this repo yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}

function PermissionBadge({ permission }) {
  const colors = {
    admin:    "#68d391",
    maintain: "#63b3ed",
    write:    "#76e4f7",
    triage:   "#fbd38d",
    read:     "#94a3b8",
    none:     "#fc8181",
  };
  return <span style={{ color: colors[permission] ?? "#94a3b8", fontWeight: 600 }}>{permission}</span>;
}

function OutcomeBadge({ outcome }) {
  const map = {
    SUCCESS: { color: "#68d391", label: "✅ Success" },
    FAILURE: { color: "#fc8181", label: "❌ Failure" },
    REVERTED: { color: "#f6ad55", label: "⏪ Reverted" },
    PENDING: { color: "#94a3b8", label: "⏳ Pending" },
  };
  const entry = map[outcome] ?? { color: "#94a3b8", label: outcome ?? "—" };
  return <span style={{ color: entry.color }}>{entry.label}</span>;
}
