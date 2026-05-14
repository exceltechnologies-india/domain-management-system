#!/bin/bash
# Simple deployment script for Next.js app

echo "🚀 Starting deployment..."

# Create logs directory if it doesn't exist
mkdir -p "deployment-logs"

# Generate timestamp for log files
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_DIR="deployment-logs/$TIMESTAMP"
mkdir -p "$LOG_DIR" || { echo "❌ Failed to create log directory $LOG_DIR"; exit 1; }

# 0. Load environment variables from .env.local
echo "📍 Loading environment variables..."
if [ -f .env.local ]; then
  # Safer way to load environment variables
  set -a
  source .env.local
  set +a
  echo "✅ Environment variables loaded from .env.local"
else
  echo "⚠️  Warning: .env.local not found"
fi

# Set default PORT if not set
PORT="${PORT:-3000}"

echo "📝 Saving deployment logs to: $LOG_DIR"
echo "🔧 Targeting PORT: $PORT"

# Ensure LOG_DIR exists (redundant but safe)
mkdir -p "$LOG_DIR"

# Save current PM2 logs before deployment
pm2 logs next-app --lines 500 --nostream > "$LOG_DIR/pm2-logs-before-deploy.log" 2>&1 || echo "No previous logs found"

# Save PM2 status before deployment
pm2 status > "$LOG_DIR/pm2-status-before-deploy.txt" 2>&1 || echo "No PM2 status available"

# 1. Stop PM2 server
echo "📍 Deleting PM2 processes..."
pm2 delete next-app 2>/dev/null || echo "Processes not running"

# 2. Kill port
echo "📍 Killing port $PORT..."
if command -v lsof >/dev/null 2>&1; then
    lsof -ti:$PORT | xargs kill -9 2>/dev/null || echo "Port $PORT is clear"
elif command -v fuser >/dev/null 2>&1; then
    fuser -k $PORT/tcp 2>/dev/null || echo "Port $PORT is clear"
else
    echo "⚠️  Warning: neither lsof nor fuser found. Skipping port kill."
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

# 4. Clear previous build output but preserve Next.js compile cache
echo "📍 Clearing previous build output (preserving cache)..."
rm -rf .next/static .next/server .next/BUILD_ID \
       .next/app-path-routes-manifest.json \
       .next/routes-manifest.json \
       .next/build-manifest.json \
       .next/prerender-manifest.json \
       .next/react-loadable-manifest.json

# 4a. Lint check (fast pre-build gate)
echo "📍 Running lint..."
npm run lint >> "$LOG_DIR/build-output.log" 2>&1
if [ $? -ne 0 ]; then
  echo "❌ Lint failed! Fix errors before deploying."
  echo "Check logs at: $LOG_DIR/build-output.log"
  exit 1
fi

echo "📍 Building application..."
npm run build >> "$LOG_DIR/build-output.log" 2>&1

# Check if build succeeded
if [ $? -eq 0 ]; then
    echo "✅ Build successful!"
else
    echo "❌ Build failed! Deployment aborted."
    echo "Check logs at: $LOG_DIR/build-output.log"
    exit 1
fi

# 4b. Run pending DB migrations. Must happen after build (ts-node + deps available)
# and before PM2 start (so new code never sees a stale schema).
echo "📍 Checking DB migration status..."
npm run migrate:status >> "$LOG_DIR/migrate.log" 2>&1 || {
  echo "❌ Migration status check failed. See $LOG_DIR/migrate.log"
  exit 1
}

echo "📍 Applying pending DB migrations..."
npm run migrate >> "$LOG_DIR/migrate.log" 2>&1
if [ $? -ne 0 ]; then
  echo "❌ DB migration failed. Deployment aborted."
  echo "Check logs at: $LOG_DIR/migrate.log"
  exit 1
fi
echo "✅ Migrations up to date"

# Copy public assets and static files into the standalone output.
# next build with output:'standalone' creates .next/standalone/server.js which
# calls process.chdir(__dirname) — so it looks for public/ and .next/static/
# relative to .next/standalone/, not the project root.
# Without these copies the standalone server returns 404 for every image/font/JS.
echo "📍 Copying public/ and .next/static into standalone output..."
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
echo "✅ Standalone assets copied"

# 5. Start PM2 server (force production env)
echo "📍 Starting PM2 server..."
NODE_ENV=production pm2 start ecosystem.config.js --env production

# Wait a few seconds for server to stabilize
sleep 3

# Save post-deployment logs
echo "📝 Saving post-deployment logs..."
pm2 logs next-app --lines 100 --nostream > "$LOG_DIR/pm2-logs-after-deploy.log" 2>&1

# Save post-deployment status
pm2 status > "$LOG_DIR/pm2-status-after-deploy.txt" 2>&1

# Save deployment summary
cat > "$LOG_DIR/deployment-summary.txt" << EOF
===========================================
DEPLOYMENT SUMMARY
===========================================
Deployment Time: $TIMESTAMP
Server: next-app
Action: Stop → Clean → Build → Start

Build Status: SUCCESS
===========================================

Log Files:
- pm2-logs-before-deploy.log
- pm2-logs-after-deploy.log
- pm2-status-before-deploy.txt
- pm2-status-after-deploy.txt
- build-output.log
- deployment-summary.txt

===========================================
EOF

echo "✅ Deployment complete!"
echo ""
echo "📊 Server status:"
pm2 status

echo ""
echo "📝 Deployment logs saved to: $LOG_DIR"
echo "📝 View current logs with: pm2 logs next-app"
echo ""
echo "📂 Recent deployment logs:"
ls -lt deployment-logs/ | head -5
