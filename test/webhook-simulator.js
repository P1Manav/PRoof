// Simple script to test the V2 webhook endpoint
import fetch from "node-fetch";

async function simulateWebhook() {
  const payload = {
    action: "opened",
    pull_request: {
      number: 1,
      additions: 10,
      deletions: 2,
      changed_files: 1,
      body: "Adding a simple greet utility to demo PRoof V2.",
    },
    repository: {
      name: "PRoof",
      full_name: "P1Manav/PRoof",
      owner: { login: "P1Manav" }
    },
    installation: { id: 12345 } // Fake ID
  };

  try {
    const res = await fetch("http://localhost:3000/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    console.log("Webhook Simulator Response:", data);
  } catch (err) {
    console.error("Simulation failed:", err);
  }
}

simulateWebhook();
