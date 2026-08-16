import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import "./globals.css";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Force dynamic rendering so it always fetches fresh DB data
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  // Fetch Leaderboard
  const users = await prisma.user.findMany({
    orderBy: { totalConfidence: 'desc' },
    take: 10,
  });

  // Fetch Feed
  const recentReceipts = await prisma.receipt.findMany({
    orderBy: { timestamp: 'desc' },
    take: 10,
    include: { user: true },
  });

  // Calculate success rates if total PRs > 0
  const leaderboard = users.map(user => {
    const total = user.successfulPrs + user.failedPrs;
    const rate = total > 0 ? Math.round((user.successfulPrs / total) * 100) : 0;
    return { ...user, successRate: rate };
  });

  return (
    <div className="container">
      <header className="header">
        <h1 className="title">PRoof Dashboard</h1>
        <p className="subtitle">Developer accountability and confidence tracking.</p>
      </header>

      <main className="grid">
        {/* LEADERBOARD PANEL */}
        <section className="glass-panel" style={{ animationDelay: '0.1s' }}>
          <h2 className="panel-title">🏆 Top Developers</h2>
          {leaderboard.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No developers yet.</p>
          ) : (
            <ul className="leaderboard-list">
              {leaderboard.map((user, index) => (
                <li key={user.id} className="leaderboard-item" style={{ animationDelay: `${0.2 + index * 0.1}s` }}>
                  <div className="user-info">
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt={user.login} className="avatar" />
                    ) : (
                      <div className="avatar" />
                    )}
                    <span className="user-name">@{user.login}</span>
                  </div>
                  <div className="user-stats">
                    <div className="score">{user.totalConfidence} pt</div>
                    <div className="success-rate">{user.successRate}% Success</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* FEED PANEL */}
        <section className="glass-panel" style={{ animationDelay: '0.3s' }}>
          <h2 className="panel-title">🧾 Recent Receipts</h2>
          {recentReceipts.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No receipts logged yet.</p>
          ) : (
            <div>
              {recentReceipts.map((receipt, index) => (
                <div key={receipt.id} className="feed-item" style={{ animationDelay: `${0.4 + index * 0.1}s` }}>
                  <div className="feed-header">
                    <span className="feed-repo">{receipt.repoFullName}</span>
                    <span className="feed-sha">{receipt.sha.slice(0, 7)}</span>
                  </div>
                  <div className="feed-body">
                    <strong>@{receipt.user.login}</strong> logged confidence: 
                    <span style={{ color: "var(--accent)", fontWeight: "bold", marginLeft: "0.5rem" }}>
                      {receipt.confidence}/10
                    </span>
                    {receipt.outcome && (
                      <span className={`badge ${receipt.outcome === 'SUCCESS' ? 'badge-success' : 'badge-failure'}`}>
                        {receipt.outcome}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export const metadata = {
  title: "PRoof Dashboard",
  description: "Developer accountability and confidence tracking",
};
