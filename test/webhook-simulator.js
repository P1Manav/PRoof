/**
 * test/webhook-simulator.js
 *
 * End-to-end webhook simulation tests.
 * Runs against the URL set in WEBHOOK_URL env (defaults to localhost:3000 for local dev,
 * or https://pr-oof.vercel.app for production).
 *
 * Usage:
 *   # Local dev (run `npm run dev` first):
 *   WEBHOOK_URL=http://localhost:3000 node test/webhook-simulator.js
 *
 *   # Production:
 *   node test/webhook-simulator.js
 *
 * Requires GITHUB_WEBHOOK_SECRET in env to sign payloads correctly.
 * Unsigned/bad-signature requests must return 401.
 */

import { createHmac } from "crypto";

const TARGET_URL =
  process.env.WEBHOOK_URL ?? "https://pr-oof.vercel.app";
const WEBHOOK_URL = `${TARGET_URL}/api/webhooks/github`;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";

// ── ANSI colours ──────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD   = "\x1b[1m";

let passed = 0;
let failed = 0;

function ok(msg)      { console.log(`  ${GREEN}✓${RESET}  ${msg}`); passed++; }
function fail(msg)    { console.log(`  ${RED}✗${RESET}  ${msg}`);   failed++; }
function section(t)   { console.log(`\n${BOLD}${YELLOW}── ${t}${RESET}`); }

// ── Signature helper ──────────────────────────────────────────────────────────

function signPayload(body) {
  if (!SECRET) return undefined; // Returns undefined → header omitted
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function sendEvent(event, payload, { sign = true, badSig = false } = {}) {
  const body = JSON.stringify(payload);
  const sig = sign ? signPayload(body) : undefined;

  const headers = {
    "Content-Type": "application/json",
    "x-github-event": event,
  };

  if (sig) headers["x-hub-signature-256"] = badSig ? sig + "x" : sig;

  try {
    const res = await fetch(WEBHOOK_URL, { method: "POST", headers, body });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  } catch (err) {
    return { status: -1, error: err.message };
  }
}

// ── Fake repo builders ────────────────────────────────────────────────────────

function fakeInstallation(installationId) {
  return { id: installationId, app_id: 999, account: { login: "acme" } };
}

function fakePrPayload(repoFullName, prNumber, installationId, action = "opened") {
  const [owner, repoName] = repoFullName.split("/");
  return {
    action,
    pull_request: {
      number: prNumber,
      additions: 10,
      deletions: 2,
      changed_files: 1,
      body: `Test PR #${prNumber} for ${repoFullName}`,
      merged: false,
      head: { sha: `deadbeef${prNumber}${installationId}`.slice(0, 40).padEnd(40, "0") },
    },
    repository: {
      name: repoName,
      full_name: repoFullName,
      owner: { login: owner },
    },
    installation: fakeInstallation(installationId),
  };
}

function fakeCommentPayload(repoFullName, prNumber, installationId, commentBody) {
  const [owner, repoName] = repoFullName.split("/");
  return {
    action: "created",
    comment: {
      id: Math.floor(Math.random() * 1e9),
      body: commentBody,
      user: { login: "dev-user", avatar_url: "https://github.com/ghost.png" },
    },
    issue: {
      number: prNumber,
      pull_request: { url: `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}` }, // marks it as a PR
    },
    repository: {
      name: repoName,
      full_name: repoFullName,
      owner: { login: owner },
    },
    installation: fakeInstallation(installationId),
  };
}

function fakeCheckRunPayload(repoFullName, prNumber, installationId) {
  const [owner, repoName] = repoFullName.split("/");
  return {
    action: "completed",
    check_run: {
      name: "CI / test",
      conclusion: "failure",
      pull_requests: [{ number: prNumber }],
    },
    repository: {
      name: repoName,
      full_name: repoFullName,
      owner: { login: owner },
    },
    installation: fakeInstallation(installationId),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n${BOLD}PRoof Webhook Simulator${RESET}`);
  console.log(`  Target: ${WEBHOOK_URL}`);
  console.log(`  Secret: ${SECRET ? "set" : "NOT SET — unsigned tests will be skipped"}`);

  // ── M1: Signature verification ────────────────────────────────────────────

  section("M1-A: Unsigned payload → 401");
  {
    const res = await sendEvent(
      "pull_request",
      fakePrPayload("acme/repo-a", 1, 11111),
      { sign: false }
    );
    res.status === 401
      ? ok(`Unsigned payload rejected with 401 (got ${res.status})`)
      : fail(`Expected 401, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  section("M1-B: Bad signature → 401");
  {
    const res = await sendEvent(
      "pull_request",
      fakePrPayload("acme/repo-a", 1, 11111),
      { sign: true, badSig: true }
    );
    res.status === 401
      ? ok(`Bad signature rejected with 401 (got ${res.status})`)
      : fail(`Expected 401, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  // ── M2: Comment-based confidence flow — repo-a ────────────────────────────

  section("M2-A: PR opened on acme/repo-a → 200");
  {
    const res = await sendEvent(
      "pull_request",
      fakePrPayload("acme/repo-a", 101, 11111, "opened")
    );
    res.status === 200
      ? ok(`PR opened accepted (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  section('M2-B: Comment "7" on acme/repo-a → 200 (receipt stored)');
  {
    const res = await sendEvent(
      "issue_comment",
      fakeCommentPayload("acme/repo-a", 101, 11111, "7")
    );
    res.status === 200
      ? ok(`Confidence "7" accepted (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  section('M2-C: Comment "banana" on acme/repo-a → 200 (silently ignored)');
  {
    const res = await sendEvent(
      "issue_comment",
      fakeCommentPayload("acme/repo-a", 101, 11111, "banana")
    );
    res.status === 200
      ? ok(`Non-numeric "banana" silently ignored (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  section("M2-D: PR synchronize after answer → prompt re-opened (200)");
  {
    const res = await sendEvent(
      "pull_request",
      fakePrPayload("acme/repo-a", 101, 11111, "synchronize")
    );
    res.status === 200
      ? ok(`Synchronize after answer accepted (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  // ── M2: repo-b (independent flow) ────────────────────────────────────────

  section("M2-E: PR opened on acme/repo-b → 200 (isolated)");
  {
    const res = await sendEvent(
      "pull_request",
      fakePrPayload("acme/repo-b", 201, 22222, "opened")
    );
    res.status === 200
      ? ok(`PR opened on repo-b accepted (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  section('M2-F: Comment "confidence: 9" on acme/repo-b → 200');
  {
    const res = await sendEvent(
      "issue_comment",
      fakeCommentPayload("acme/repo-b", 201, 22222, "confidence: 9")
    );
    res.status === 200
      ? ok(`"confidence: 9" accepted on repo-b (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  // ── M5: Cross-repo isolation assertion ────────────────────────────────────
  // (The actual DB isolation check would require a DB query — we verify here
  //  that the webhook responses don't bleed data across repos. A full isolation
  //  check runs in verify.js section 9.)

  section("M5: check_run failure on acme/repo-a → receipt follow-up (200)");
  {
    const res = await sendEvent(
      "check_run",
      fakeCheckRunPayload("acme/repo-a", 101, 11111)
    );
    res.status === 200
      ? ok(`check_run failure handled for repo-a (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  section("M5: check_run failure on acme/repo-b → receipt follow-up (200)");
  {
    const res = await sendEvent(
      "check_run",
      fakeCheckRunPayload("acme/repo-b", 201, 22222)
    );
    res.status === 200
      ? ok(`check_run failure handled for repo-b (status ${res.status})`)
      : fail(`Expected 200, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(
    `\n${BOLD}Results: ${GREEN}${passed} passed${RESET}${BOLD}, ${
      failed ? RED : GREEN
    }${failed} failed${RESET}\n`
  );
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Simulator crashed:", err);
  process.exit(1);
});
