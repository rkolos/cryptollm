module.exports = {
  apps: [
    {
      name: 'cryptollm-dev',
      script: 'npm',
      args: 'run dev',
      cwd: '/home/cryptollm',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
      },
      error_file: '/home/cryptollm/logs/pm2-error.log',
      out_file: '/home/cryptollm/logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};

