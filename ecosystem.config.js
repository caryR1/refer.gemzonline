/**
 * PM2 process definition — used on a Hostinger VPS.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 *
 * Deliberately single-instance: the scheduler lives inside the web process, so
 * running several would fire reminders more than once. The reminder table
 * guards against duplicates anyway, but one process is simpler and this app
 * will not be CPU-bound. If you ever do need cluster mode, set ENABLE_CRON=false
 * on every instance but one.
 */
module.exports = {
  apps: [
    {
      name: 'refer-gemzonline',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout: 10000,
    },
  ],
};
