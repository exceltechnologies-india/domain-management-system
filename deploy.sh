#!/bin/bash
# VPS deployment script for the Next.js standalone server.
#
# On Cloud Run this script is not used — the Dockerfile + `gcloud run deploy`
# handle the lifecycle. This script is the transitional VPS path. PM2 was
# previously used for process supervision; it has been dropped because:
#   - Cloud Run autoscales and restarts containers; supervision is its job.
#   - On a VPS, systemd (or any init supervisor) is the proper restart loop —
#     deploy.sh just gracefully swaps the process; whatever started it is
#     responsible for keeping it up.
#
# If you want auto-restart on a VPS, register a systemd unit that runs:
#     node --env-file=.env.local .next/standalone/server.js
# from this directory with Restart=always.

set -u

echo "🚀 Starting deployment..."

mkdir -p "deployment-logs"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_DIR="deployment-logs/$TIMESTAMP"
mkdir -p "$LOG_DIR" || { echo "❌ Failed to create log directory $LOG_DIR"; exit 1; }

# 0. Load environment variables from .env.local
echo "📍 Loading environment variables..."
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
  echo "✅ Environment variables loaded from .env.local"
else
  echo "⚠️  Warning: .env.local not found"
fi

PORT="${PORT:-3000}"
PID_FILE="deployment-logs/.server.pid"

echo "📝 Saving deployment logs to: $LOG_DIR"
echo "🔧 Targeting PORT: $PORT"

# 1. Carry forward logs from the previous run so a regression is easy to diff.
PREV_LOG=$(ls -1dt deployment-logs/2*/server.log 2>/dev/null | head -1 || true)
if [ -n "$PREV_LOG" ] && [ -f "$PREV_LOG" ]; then
  tail -n 500 "$PREV_LOG" > "$LOG_DIR/server-log-before-deploy.log" 2>&1 || true
fi

# 2. Gracefully stop the previous server.
#    SIGTERM first → up to 10s drain → SIGKILL fallback. Drops in-flight
#    Razorpay webhooks far less aggressively than the old `pm2 delete +
#    kill -9 the port` combo did.
echo "📍 Stopping previous server (graceful)..."
OLD_PID=""
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
fi
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill -TERM "$OLD_PID" 2>/dev/null || true
  for _i in $(seq 1 10); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "⚠️  Old server (PID $OLD_PID) did not exit in 10s — sending SIGKILL"
    kill -KILL "$OLD_PID" 2>/dev/null || true
  fi
fi

# 2b. Belt-and-braces: kill anything still bound to $PORT (stale process from
#     a crashed previous deploy, manual `node` invocation, etc.).
if command -v lsof >/dev/null 2>&1; then
  lsof -ti:"$PORT" 2>/dev/null | xargs -r kill -KILL 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT"/tcp 2>/dev/null || true
fi

# 3. Conditionally reinstall dependencies (skip if package-lock.json unchanged)
LOCK_HASH_FILE=".npm-lock-hash"
CURRENT_HASH=$(md5sum package-lock.json 2>/dev/null | awk '{print $1}')
STORED_HASH=$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo "")

if [ "$CURRENT_HASH" != "$STORED_HASH" ] || [ ! -d node_modules ]; then
  echo "📍 Dependencies changed — reinstalling..."
  rm -rf node_modules
  npm ci >> "$LOG_DIR/build-output.log" 2>&1
  echo "$CURRENT_HASH" > "$LOCK_HASH_FILE"
  echo "✅ Dependencies installed"
else
  echo "📍 Dependencies unchanged — skipping reinstall"
fi

# 4. Atomic-swap setup: preserve the current .next as .next.prev so any failure
#    after this point can be rolled back to the last good build. This replaces
#    the old "clear partial build, keep the cache" trick. Cost: build no longer
#    benefits from the incremental compile cache, so it runs ~30-60s longer.
#    Trade-off accepted in exchange for atomicity — a failed build no longer
#    leaves the deployment in a broken half-state.
echo "📍 Preserving current build as .next.prev (rollback point)..."
rm -rf .next.prev
[ -d .next ] && mv .next .next.prev

# Helper: roll back .next from .next.prev. Called on any failure between here
# and the final "atomic swap complete" line.
rollback_next() {
  local reason="$1"
  echo "⏪ Rolling back .next/ (reason: $reason)"
  rm -rf .next
  [ -d .next.prev ] && mv .next.prev .next
}

# 4a. Lint check (fast pre-build gate)
echo "📍 Running lint..."
if ! npm run lint >> "$LOG_DIR/build-output.log" 2>&1; then
  rollback_next "lint failed"
  echo "❌ Lint failed! Fix errors before deploying."
  echo "Check logs at: $LOG_DIR/build-output.log"
  exit 1
fi

echo "📍 Building application..."
if npm run build >> "$LOG_DIR/build-output.log" 2>&1; then
  echo "✅ Build successful!"
else
  rollback_next "build failed"
  echo "❌ Build failed! Deployment aborted."
  echo "Check logs at: $LOG_DIR/build-output.log"
  exit 1
fi

# 4b. Run pending DB migrations. Must happen after build (tsx + deps available)
# and before server start (so new code never sees a stale schema).
echo "📍 Checking DB migration status..."
if ! npm run migrate:status >> "$LOG_DIR/migrate.log" 2>&1; then
  rollback_next "migration status check failed"
  echo "❌ Migration status check failed. See $LOG_DIR/migrate.log"
  exit 1
fi

echo "📍 Applying pending DB migrations..."
if ! npm run migrate >> "$LOG_DIR/migrate.log" 2>&1; then
  # Note: schema may be in a partially-migrated state on this path. The fresh
  # build is rolled back, but the DB is not — a migration that ran half-way
  # cannot be undone from the deploy script. Operator must inspect manually.
  rollback_next "migration failed (DB may be partially applied — investigate)"
  echo "❌ DB migration failed. Deployment aborted."
  echo "Check logs at: $LOG_DIR/migrate.log"
  exit 1
fi
echo "✅ Migrations up to date"

# Atomic swap is now complete. From this point on .next is the new build and
# .next.prev is the previous-good rollback target. To roll back to the
# previous deploy after this point:
#   ./deploy.sh stop     (manually kill the running server via the PID file)
#   mv .next .next.failed && mv .next.prev .next
#   then re-run the start step (or re-run deploy.sh from scratch — it will
#   pick up .next as the "current" state).

# Copy public assets and static files into the standalone output.
# next build with output:'standalone' creates .next/standalone/server.js which
# calls process.chdir(__dirname) — so it looks for public/ and .next/static/
# relative to .next/standalone/, not the project root.
# Without these copies the standalone server returns 404 for every image/font/JS.
echo "📍 Copying public/ and .next/static into standalone output..."
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
echo "✅ Standalone assets copied"

# 5. Start the standalone server in the background.
#    Uses node's --env-file to load .env.local (replaces the PM2 ecosystem.config
#    env-loading + NODE_OPTIONS). nohup + setsid detaches it from this shell so
#    the script can exit cleanly. Logs go to $LOG_DIR/server.log.
echo "📍 Starting standalone server (detached)..."
NODE_ENV=production \
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}" \
PORT="$PORT" \
nohup setsid node --env-file=.env.local .next/standalone/server.js \
  >> "$LOG_DIR/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "$SERVER_PID" > "$PID_FILE"
echo "✅ Server started (PID $SERVER_PID, logs: $LOG_DIR/server.log)"

# Wait briefly for the server to bind to the port; report status.
sleep 3
if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "✅ Server is alive after 3s"
else
  echo "❌ Server died within 3s — check $LOG_DIR/server.log"
  tail -n 50 "$LOG_DIR/server.log" || true
  exit 1
fi

# Save deployment summary
cat > "$LOG_DIR/deployment-summary.txt" << EOF
===========================================
DEPLOYMENT SUMMARY
===========================================
Deployment Time: $TIMESTAMP
Server PID:      $SERVER_PID
PORT:            $PORT
Action: Stop → Clean → Build → Migrate → Start

Build Status: SUCCESS
===========================================

Log Files in this run:
- server-log-before-deploy.log  (tail of previous deploy's server.log)
- server.log                    (live log of the new process)
- build-output.log
- migrate.log
- deployment-summary.txt
===========================================
EOF

echo ""
echo "✅ Deployment complete!"
echo "📝 Tail live logs with: tail -f $LOG_DIR/server.log"
echo "📂 Recent deployments:"
ls -lt deployment-logs/ | head -5
