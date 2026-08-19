#!/usr/bin/env node
/**
 * test/run-all.js
 *
 * Runs all PRoof test suites in sequence.
 * Exits with code 1 if any suite fails.
 */

import { spawnSync } from "child_process";

const tests = [
  "test/verify.js",           // Original test suite
  "test/permissions.test.js", // M1
  "test/rulesets.test.js",    // M3
  "test/commands.test.js",    // M4
  "test/e2e.test.js",         // M5
  "test/proxy.test.js",       // M8
  "test/dashboard-list.test.js", // M9
  "test/dashboard-repo.test.js", // M10
];

console.log(`\x1b[1m\x1b[36mRunning ${tests.length} test suites...\x1b[0m\n`);

let failed = 0;
const cwd = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

for (const test of tests) {
  console.log(`\x1b[1m\x1b[34m=== ${test} ===\x1b[0m`);
  const result = spawnSync(process.execPath, [test], {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
  });

  if (result.status !== 0) {
    console.log(`\x1b[31m✗ ${test} failed.\x1b[0m\n`);
    failed++;
  } else {
    console.log(`\x1b[32m✓ ${test} passed.\x1b[0m\n`);
  }
}

if (failed > 0) {
  console.log(`\x1b[1m\x1b[31m${failed} test suite(s) failed.\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\x1b[1m\x1b[32mAll ${tests.length} test suites passed!\x1b[0m`);
  process.exit(0);
}
