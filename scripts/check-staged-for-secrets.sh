#!/usr/bin/env bash
# Pre-commit guard: scan staged files for secret-shaped strings and
# refuse the commit if any are found.
#
# Born from a 2026-06-29 incident where a MongoDB Atlas connection
# string with an embedded password was found in git history (file:
# test-full-app.js, committed in the initial commit; removed from the
# working tree but still in history until the post-rotation force-push).
# Cost: history rewrite + force-push + password rotation in Atlas +
# Secret Manager v2 + Cloud Run redeploy. Worth not repeating.
#
# What this catches:
#   - MongoDB URIs with embedded credentials  mongodb(+srv)?://USER:PASSWORD@HOST
#   - Razorpay live/test KEY SECRETS          rzp_live_/rzp_test_ + 20+ chars
#     (the Key ID is shorter and is `NEXT_PUBLIC_*` so it ships in the JS
#     bundle by design — only the SECRET is dangerous; we filter that)
#   - Anthropic API keys                      sk-ant- + 20+ chars
#   - AWS access keys                         AKIA + 16 caps/digits
#   - Generic env-var-shape secret strings    KEY/SECRET/TOKEN/PASSWORD = long-random
#   - Private-key PEM blocks                  BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY
#   - GCP service-account private_key field   "private_key":\s*"-----BEGIN
#
# False-positive avoidance:
#   - Test fixtures with intentional honeypot strings (e.g.
#     "secret-hash-leak-me-please") are allowed because they don't
#     match the patterns above (they're not random-shaped enough).
#   - .env.example is allowed (canonical template with blank values).
#   - This script itself is excluded from its own check (it contains
#     the regex literals).
#
# Override: --no-verify on git commit will skip this check. The auto-
# memory feedback `feedback_skip_pre_commit_only_when_necessary` says
# overrides are discouraged; if you skip and a secret slips, the cost
# is far higher than the rare false-positive friction.
set -euo pipefail

# Files staged for commit (Added/Modified, not Deleted)
staged=$(git diff --cached --name-only --diff-filter=AM)
if [ -z "$staged" ]; then
  exit 0
fi

# Skip files that are themselves the scanner or canonical templates.
skip_pattern='^(\.env\.example|scripts/check-staged-for-secrets\.sh)$'

# Regex bank — each pattern matches an actual secret SHAPE, not just a
# label. Tested to NOT match the existing intentional test fixtures.
patterns=(
  # MongoDB URI with embedded credentials (user:password@host)
  'mongodb(\+srv)?://[^:[:space:]]+:[^@[:space:]]+@'
  # Razorpay live/test key SECRET (24+ chars after rzp_live_/rzp_test_).
  # Public Key IDs are ~14 chars and won't trigger.
  'rzp_(live|test)_[A-Za-z0-9]{24,}'
  # Anthropic API keys
  'sk-ant-[A-Za-z0-9_-]{20,}'
  # AWS access key IDs
  'AKIA[0-9A-Z]{16}'
  # GCP service-account private_key JSON field
  '"private_key":[[:space:]]*"-----BEGIN'
  # PEM private-key blocks
  '-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----'
  # Env-shape secret assignment: KEY/SECRET/TOKEN/PASSWORD = "long-random"
  # Requires both a credential-y label AND a 20+ char random-looking
  # value. Skips short placeholders + dotted CLI flags.
  '^[+]?[[:space:]]*(export[[:space:]]+)?[A-Z_]*([_-]?KEY|[_-]?SECRET|[_-]?TOKEN|[_-]?PASSWORD|[_-]?PASSWD|[_-]?PWD)[A-Z_]*[[:space:]]*=[[:space:]]*["'\''][A-Za-z0-9+/=_-]{20,}["'\'']'
)

found_any=0
declare -a findings

for file in $staged; do
  # Skip our own scanner + the env-template
  if echo "$file" | grep -qE "$skip_pattern"; then
    continue
  fi
  # Skip binary files — they confuse grep + secrets in binaries are rare
  if ! git diff --cached --no-color -- "$file" | head -c 1 >/dev/null 2>&1; then
    continue
  fi

  for pat in "${patterns[@]}"; do
    # Only scan the ADDED lines (lines starting with '+', excluding
    # the '+++' header). This means a secret existing in the file
    # before staging won't re-trigger; only NEW secret material does.
    # `-e PATTERN` so patterns starting with `-` (e.g. PEM header
    # `-----BEGIN ...`) aren't misread as grep flags.
    matches=$(git diff --cached --no-color -- "$file" \
      | grep -E -e "^\+[^+]" \
      | grep -nE -e "$pat" || true)
    if [ -n "$matches" ]; then
      found_any=1
      findings+=("$file: pattern matched: $pat")
      findings+=("$matches")
      findings+=("---")
    fi
  done
done

if [ "$found_any" -eq 1 ]; then
  echo ""
  echo "❌ COMMIT BLOCKED — secret-shaped strings detected in staged files."
  echo ""
  for line in "${findings[@]}"; do
    echo "   $line"
  done
  echo ""
  echo "If this is a false positive (e.g. intentional test fixture),"
  echo "either rename to match an allowed pattern, or — if you must —"
  echo "skip with: git commit --no-verify"
  echo ""
  echo "If real, DO NOT commit. Move the value to Secret Manager + .env.local"
  echo "(both gitignored) and reference it via process.env.NAME."
  echo ""
  exit 1
fi

exit 0
