/**
 * src/app/dashboard/page.js
 *
 * M9 — Repo list dashboard.
 *
 * Shows all repos where:
 *   1. PRoof is installed (tracked in the Installation DB table), AND
 *   2. The signed-in user's OAuth token can list (via GET /user/installations)
 *
 * For each repo, displays the user's live permission tier.
 * Permission is checked via the app installation Octokit (which has
 * Administration: read scope) — NOT the user's OAuth token.
 *
 * Security: auth() is called server-side; no trust from client.
 * The proxy already redirected unauthenticated users — this is a second check.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Octokit } from "octokit";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getOctokit } from "@/lib/githubApp";
import { getUserPermission } from "@/lib/permissions";
import { getRepoSettings } from "@/lib/proofActions";

export const metadata = {
  title: "Dashboard — PRoof",
  description: "Your PRoof confidence dashboard",
};

// Force dynamic rendering — never cache this page.
export const dynamic = "force-dynamic";

// ── Prisma singleton ──────────────────────────────────────────────────────────
const globalForPrisma = globalThis;
if (!globalForPrisma.prismaDash) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  globalForPrisma.prismaDash = new PrismaClient({ adapter });
}
const prisma = globalForPrisma.prismaDash;

// ── Data fetching ─────────────────────────────────────────────────────────────

async function getReposForUser(userAccessToken) {
  if (!userAccessToken) return [];

  // Use the user's own OAuth token to list their installations
  const userOctokit = new Octokit({ auth: userAccessToken });

  let allRepos = [];
  try {
    // List installations accessible to this user
    const { data: installationsData } = await userOctokit.rest.apps.listInstallationsForAuthenticatedUser({
      per_page: 100,
    });

    for (const installation of installationsData.installations) {
      try {
        // List repos for each installation the user can access
        const { data: repoData } = await userOctokit.rest.apps.listInstallationReposForAuthenticatedUser({
          installation_id: installation.id,
          per_page: 100,
        });
        for (const r of repoData.repositories) {
          allRepos.push(r.full_name);
        }
      } catch {
        // Skip installations the user can't enumerate
      }
    }
  } catch {
    // If the token doesn't have the right scopes, return empty
    return [];
  }

  return allRepos;
}

// ── Page component ────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  // Re-check session server-side (proxy is first line, this is the actual gate)
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const userLogin = session.user?.login ?? session.user?.name;
  const accessToken = session.accessToken;

  // Get all repos this user's OAuth token can see via app installations
  const userRepos = await getReposForUser(accessToken);

  // Cross-reference with PRoof's own Installation table
  const allInstallations = await prisma.installation.findMany({
    select: { repos: true, id: true },
  });
  const proofRepos = new Set(allInstallations.flatMap((i) => i.repos));

  // Only show repos that are in BOTH the user's list AND PRoof's list
  const visibleRepos = userRepos.filter((r) => proofRepos.has(r));

  // For each repo, get the live permission and settings
  const repoData = await Promise.all(
    visibleRepos.map(async (fullName) => {
      const [owner, repo] = fullName.split("/");

      // Find the installation ID for this repo to get app-scoped Octokit
      const installation = allInstallations.find((i) => i.repos.includes(fullName));
      if (!installation) return null;

      try {
        const octokit = await getOctokit(installation.id);
        const permission = await getUserPermission(octokit, owner, repo, userLogin);
        const settings = await getRepoSettings({ owner, repo });

        return { fullName, owner, repo, permission, mandatory: settings.mandatory };
      } catch {
        return null;
      }
    })
  );

  const validRepos = repoData.filter(Boolean);

  return (
    <main style={{ background: "#0b0f19", color: "#e2e8f0", minHeight: "100vh", fontFamily: "monospace", padding: "2rem" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
          <h1 style={{ fontSize: "1.5rem", margin: 0 }}>🧾 PRoof Dashboard</h1>
          <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
            Signed in as <strong>{userLogin}</strong>
          </span>
        </div>

        {validRepos.length === 0 ? (
          <p style={{ color: "#94a3b8" }}>
            No repos found where PRoof is installed and you have access.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {validRepos.map(({ fullName, owner, repo, permission, mandatory }) => (
              <a
                key={fullName}
                href={`/dashboard/${owner}/${repo}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "1rem 1.25rem",
                  background: "#141922",
                  border: "1px solid #2d3748",
                  borderRadius: "0.5rem",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: "#f0f4f8" }}>{fullName}</div>
                  <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "0.2rem" }}>
                    Your role: <PermissionBadge permission={permission} />
                    {mandatory && (
                      <span style={{ marginLeft: "0.75rem", color: "#f6ad55" }}>• Mandatory enforcement ON</span>
                    )}
                  </div>
                </div>
                <span style={{ color: "#4a5568" }}>→</span>
              </a>
            ))}
          </div>
        )}
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
  return (
    <span style={{ color: colors[permission] ?? "#94a3b8", fontWeight: 600 }}>
      {permission}
    </span>
  );
}
