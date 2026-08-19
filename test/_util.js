/**
 * test/_util.js
 *
 * Shared test utilities for all PRoof test files.
 * Mirrors the ok/fail/section helpers in test/verify.js.
 */

export const RESET  = '\x1b[0m';
export const GREEN  = '\x1b[32m';
export const RED    = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const BOLD   = '\x1b[1m';

let passed = 0;
let failed = 0;

export function ok(msg)      { console.log(`  ${GREEN}✓${RESET}  ${msg}`); passed++; }
export function fail(msg)    { console.log(`  ${RED}✗${RESET}  ${msg}`);   failed++; }
export function section(t)   { console.log(`\n${BOLD}${YELLOW}── ${t}${RESET}`); }

export function summary(label) {
  console.log(`\n${BOLD}${label}: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed ? RED : GREEN}${failed} failed${RESET}\n`);
  const exitCode = failed > 0 ? 1 : 0;
  // Reset for any subsequent usage in the same process (shouldn't happen, but be safe)
  passed = 0;
  failed = 0;
  return exitCode;
}
