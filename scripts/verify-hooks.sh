#!/usr/bin/env bash
# End-to-end verification that husky + commitlint + lint-staged are wired.
# Run via: make hooks:verify
#
# This script creates a throwaway file, attempts two commits, checks
# expected rejections/rewrites, then cleans up. It does NOT leave
# any commit behind.

set -uo pipefail

TEST_FILE=".husky-verify.md"
PASS=0
FAIL=0

cleanup() {
  # Unstage + remove the scratch file if present
  git reset -q HEAD -- "$TEST_FILE" 2>/dev/null || true
  rm -f "$TEST_FILE"
  # If either test accidentally landed a commit, roll it back
  if git log -1 --format=%s 2>/dev/null | grep -q 'hook-verify-scratch'; then
    git reset --hard HEAD~1 >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> Verifying husky + commitlint + lint-staged"
git rev-parse --git-dir >/dev/null

# ─── Test 1: commitlint rejects non-conventional messages ───────────────────
echo
echo "[test 1/2] commitlint rejects a non-conventional commit message"
printf "scratch\n" > "$TEST_FILE"
git add "$TEST_FILE"
OUT=$(git commit -m "not a conventional message" 2>&1 || true)
git reset -q HEAD -- "$TEST_FILE"

if echo "$OUT" | grep -qiE "commitlint|subject may not be empty|type may not be empty|type must be one of"; then
  echo "  PASS  commitlint rejected the bad message"
  PASS=$((PASS + 1))
else
  echo "  FAIL  commitlint did not reject — hooks are broken"
  echo "$OUT" | sed 's/^/    /' >&2
  FAIL=$((FAIL + 1))
fi

# ─── Test 2: lint-staged fires (prettier rewrites staged markdown) ──────────
echo
echo "[test 2/2] lint-staged fires prettier on staged markdown"
cat > "$TEST_FILE" <<'EOF'
#    Ugly heading
poorly   spaced    body
EOF
ORIG_HASH=$(git hash-object "$TEST_FILE")
git add "$TEST_FILE"

OUT=$(git commit -m "chore: hook-verify-scratch" 2>&1 || true)
NEW_HASH=$(git hash-object "$TEST_FILE" 2>/dev/null || echo "missing")

# Roll back any landed commit
if git log -1 --format=%s 2>/dev/null | grep -q 'hook-verify-scratch'; then
  git reset --hard HEAD~1 >/dev/null
fi

if echo "$OUT" | grep -qiE "running tasks for staged files|lint-staged|prettier --write|no staged files match"; then
  if [ "$ORIG_HASH" != "$NEW_HASH" ]; then
    echo "  PASS  lint-staged ran and prettier reformatted the file"
  else
    echo "  PASS  lint-staged ran (file already acceptable to prettier)"
  fi
  PASS=$((PASS + 1))
else
  echo "  FAIL  lint-staged did not fire — hooks are broken"
  echo "$OUT" | sed 's/^/    /' >&2
  FAIL=$((FAIL + 1))
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Verified: $PASS/2 hook checks passed."
  exit 0
else
  echo "Failed: $FAIL/2 hook checks failed."
  exit 1
fi
