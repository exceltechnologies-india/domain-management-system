#!/bin/bash
# run-local.sh — start the app locally with reCAPTCHA disabled and all
# self-referencing URLs pointed at localhost.
#
# WHY THIS EXISTS (and why we do NOT just blank the keys in .env.local):
#
#   1. reCAPTCHA can't work on localhost. The real site key is domain-locked
#      to app.anutech.in, so the widget renders an error box and — in a
#      production-mode build — leaves the Sign in button disabled. The app
#      already has a documented kill switch for this: an empty
#      NEXT_PUBLIC_RECAPTCHA_SITE_KEY makes the client skip the widget
#      (components/LoginForm.tsx), and an empty RECAPTCHA_SECRET_KEY makes
#      RecaptchaServer.verifyToken short-circuit to success (lib/recaptcha.ts).
#      This script sets both to empty for the local process only.
#
#   2. Blanking them in `.env.local` would be actively dangerous.
#      deploy-cloud-run.sh builds ENV_VARS with
#      `NEXT_PUBLIC_RECAPTCHA_SITE_KEY=${NEXT_PUBLIC_RECAPTCHA_SITE_KEY:-}`
#      read from that very file, so a blank there ships to Cloud Run and
#      silently disables reCAPTCHA in PRODUCTION on the next deploy. Same
#      class of silent-revert trap as HOSTING_MANDATE_FLOW on 2026-06-29.
#      (The secret is safe either way — production takes it from Secret
#      Manager — but the site key is not.)
#
#   3. --prod serves a PRODUCTION build, and lib/security/headers.ts gates its
#      security headers on NODE_ENV === 'production'. Over plain HTTP that is
#      actively hostile: the CSP carries `upgrade-insecure-requests` (Chrome
#      rewrites every http:// request to https://, which fails with
#      ERR_SSL_PROTOCOL_ERROR against this HTTP-only server) and the response
#      also sets `Strict-Transport-Security: max-age=31536000`. HSTS is
#      HOST-scoped, not port-scoped, so once Chrome caches it for `localhost`
#      it force-upgrades EVERY localhost port for a year — including a dev
#      server on :3000. Recovery is manual: chrome://net-internals/#hsts ->
#      "Delete domain security policies" -> localhost. Default dev mode runs
#      NODE_ENV=development and sends none of these. Bit us on 2026-09-04.
#
#   4. APP_URL / NEXTAUTH_URL default to https://app.anutech.in in
#      .env.local. Activation and password-reset emails are built from
#      `APP_URL || NEXTAUTH_URL` (lib/email/auth.ts), so running locally
#      WITHOUT overriding APP_URL sends real mail whose links point at
#      production — where the freshly-registered local user does not exist,
#      so activation just fails. Cost real debugging time on 2026-09-03.
#      Both are pinned to the local origin here.
#
# Usage:
#   bash scripts/run-local.sh                 # next dev on :3100
#   bash scripts/run-local.sh --port 3200     # different port
#   bash scripts/run-local.sh --prod          # production build + standalone server
#   bash scripts/run-local.sh --prod --no-build   # reuse the existing build
#
# Port defaults to 3100, not 3000, because 3000 is usually already taken by
# another dev server — and testing against the wrong server proves nothing.
#
# NOTE: by default this uses the MONGODB_URI from .env.local, i.e. the LIVE
# Atlas cluster — registering users or placing orders WILL write there. To
# work against a throwaway database, export MONGODB_URI first; the script
# preserves a caller-supplied value instead of overwriting it from the file:
#
#   export MONGODB_URI="mongodb://127.0.0.1:27019/scratch"
#   bash scripts/run-local.sh
#
# The banner prints whether the resolved database is local or remote — check
# it before doing anything that writes.

set -euo pipefail

PORT=3100
MODE=dev
BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --prod) MODE=prod; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '1,64p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ ! -f .env.local ]; then
  echo "✗ .env.local not found — run this from the repo root."
  exit 1
fi

# Preserve any override the caller already exported. `set -a; source` would
# otherwise clobber it with the .env.local value — which silently pointed a
# "throwaway database" run at the live Atlas cluster when this script was
# first written.
PRESET_MONGODB_URI="${MONGODB_URI:-}"

# shellcheck disable=SC1091
set -a; source .env.local; set +a

if [ -n "$PRESET_MONGODB_URI" ]; then
  export MONGODB_URI="$PRESET_MONGODB_URI"
fi

ORIGIN="http://localhost:${PORT}"

# The four overrides. Exported so both `next dev` and the standalone server
# inherit them; process.env takes precedence over .env files in Next, so
# these win without the file being touched.
export NEXT_PUBLIC_RECAPTCHA_SITE_KEY=""
export RECAPTCHA_SECRET_KEY=""
export APP_URL="$ORIGIN"
export NEXTAUTH_URL="$ORIGIN"
export PORT

echo "──────────────────────────────────────────────────────────────"
echo "Local run — reCAPTCHA DISABLED"
echo "──────────────────────────────────────────────────────────────"
echo "  Mode:       $MODE"
echo "  Origin:     $ORIGIN"
echo "  reCAPTCHA:  site key + secret blanked for this process only"
echo "  APP_URL:    $ORIGIN  (emails link locally, not to production)"
case "${MONGODB_URI:-}" in
  *127.0.0.1*|*localhost*) echo "  Database:   local" ;;
  *) echo "  Database:   ⚠  REMOTE (from .env.local) — writes hit the live cluster" ;;
esac
echo ""

if [ "$MODE" = "prod" ]; then
  if [ "$BUILD" = "1" ]; then
    echo "→ Building (reCAPTCHA site key baked in empty)…"
    rm -rf .next
    npm run build
  else
    echo "→ Reusing existing .next build"
    if grep -rq "NEXT_PUBLIC_RECAPTCHA_SITE_KEY" .next/static 2>/dev/null; then :; fi
  fi
  echo ""
  echo "  ⚠  PRODUCTION MODE OVER PLAIN HTTP"
  echo "     This build sends Strict-Transport-Security and a CSP containing"
  echo "     upgrade-insecure-requests. Chrome will force http://localhost to"
  echo "     https:// and fail with ERR_SSL_PROTOCOL_ERROR — and HSTS is"
  echo "     host-scoped, so it will affect EVERY localhost port for a year."
  echo "     If that happens: chrome://net-internals/#hsts -> Delete domain"
  echo "     security policies -> localhost."
  echo "     For interactive clicking-around, use dev mode (drop --prod)."
  echo ""
  # `next start` does not work with output: standalone — use the standalone
  # server, which is also what Cloud Run runs.
  echo "→ Starting standalone server on $ORIGIN"
  exec env HOSTNAME=127.0.0.1 node .next/standalone/server.js
else
  echo "→ Starting next dev on $ORIGIN"
  exec npx next dev --turbopack -p "$PORT"
fi
