// pm2 的配置，Linux / macOS / Windows 通用。用法：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'nav',
      script: 'server/index.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      // 端口等设置在网页的 设置 → 服务器 里改；也可以在上面的 env 里写 PORT、HOST、TRUST_PROXY
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
