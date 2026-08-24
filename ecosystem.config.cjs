module.exports = {
  apps: [
    {
      name: 'messenger',
      cwd: __dirname,
      script: 'node',
      args: '--env-file=.env dist-server/index.js',
      autorestart: true,
      max_restarts: 10,
      kill_timeout: 5000,
      windowsHide: true,
      out_file: 'messenger.log',
      error_file: 'messenger-error.log',
    },
  ],
};
