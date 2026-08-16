#!/usr/bin/env bash
# install.sh — installs the Receipts post-commit hook into a target git repo.
#
# Usage:
#   bash install.sh [/path/to/target/repo]
#
# If no argument is given, the current directory is used as the target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-.}"
TARGET="$(cd "$TARGET" && pwd)"   # resolve to absolute path

# ── validate ──────────────────────────────────────────────────────────────────

if [ ! -d "$TARGET/.git" ]; then
  echo "❌  Error: '$TARGET' is not a git repository (no .git directory found)."
  echo "   Run this script from inside a git repo, or pass the repo path as an argument:"
  echo "   bash install.sh /path/to/your/repo"
  exit 1
fi

HOOKS_DIR="$TARGET/.git/hooks"

# ── install ───────────────────────────────────────────────────────────────────

echo "📦  Installing Receipts hook into $TARGET ..."

cp "$SCRIPT_DIR/hook/post-commit"       "$HOOKS_DIR/post-commit"
cp "$SCRIPT_DIR/hook/log-confidence.js" "$HOOKS_DIR/log-confidence.js"
chmod +x "$HOOKS_DIR/post-commit"

# ── configure git notes push refspec (best-effort) ───────────────────────────

cd "$TARGET"
if git remote | grep -q .; then
  # Only add if not already present
  if ! git config --get-all remote.origin.push | grep -q "refs/notes/receipts"; then
    git config --add remote.origin.push "refs/notes/receipts:refs/notes/receipts" 2>/dev/null || true
    echo "✅  Configured git to push notes to origin automatically."
  else
    echo "ℹ️   Notes push refspec already configured."
  fi
fi

echo ""
echo "✅  Done! Receipts hook installed."
echo ""
echo "   After your next commit you'll be prompted for a confidence score."
echo "   Run 'receipts log' any time to review your scores."
echo ""
echo "   To push notes to GitHub:"
echo "     git push origin refs/notes/receipts"
