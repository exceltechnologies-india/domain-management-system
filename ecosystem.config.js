module.exports = {
  apps: [{
    name: 'next-app',
    script: '.next/standalone/server.js',
    node_args: '--env-file=.env.local',
    cwd: '/home/rsa-key-20251224/dd',

    instances: 1,
    exec_mode: 'fork',

    // Memory management
    max_memory_restart: '1500M',

    // Restart strategy
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '30s',
    restart_delay: 4000,
    exp_backoff_restart_delay: 100,

    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 10000,

    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: false,

    // Environment
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      NODE_OPTIONS: '--max-old-space-size=1024',
      // NEXTAUTH_URL and NEXTAUTH_SECRET should be loaded from .env.local by Next.js
    },

    // Advanced features
    shutdown_with_message: false
  }]
};