export const dynamic = "force-static";

export default function RootPage() {
  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", background: "#0b0f19", color: "#e2e8f0", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem" }}>
      <h1 style={{ fontSize: "2rem", margin: 0, color: "#f0f4f8" }}>🧾 PRoof</h1>
      <p style={{ color: "#94a3b8" }}>The app is running successfully.</p>
      <a href="/dashboard" style={{ marginTop: "1rem", padding: "0.75rem 1.5rem", background: "#4a90d9", color: "#fff", textDecoration: "none", borderRadius: "0.5rem", fontWeight: "bold" }}>
        Go to Dashboard
      </a>
    </main>
  );
}
