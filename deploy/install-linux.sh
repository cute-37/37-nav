#!/usr/bin/env bash
# 在 Linux 上把网址导航装成 systemd 服务：开机自启，崩溃后自动重启。
# 用法：在项目目录里执行  bash deploy/install-linux.sh
# 卸载：bash deploy/install-linux.sh uninstall
set -euo pipefail

SERVICE=nav
UNIT=/etc/systemd/system/$SERVICE.service
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

if [ "${1:-}" = "uninstall" ]; then
  sudo systemctl disable --now "$SERVICE" 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  echo "已卸载服务。数据还在 $DIR/data，需要的话请自行删除。"
  exit 0
fi

if ! command -v systemctl >/dev/null; then
  echo "这台机器没有 systemd。请改用 Docker 或 pm2，见 DEPLOY.md。" >&2
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "没有找到 Node.js。请先安装 22.13 或更高版本：https://nodejs.org/" >&2
  exit 1
fi
NODE="$(command -v node)"
if ! "$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "Node.js 版本太低（当前 $("$NODE" -v)），需要 22.13 或更高。" >&2
  exit 1
fi

echo "安装依赖…"
(cd "$DIR" && npm ci --omit=dev)

echo "写入 $UNIT（需要管理员权限）…"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=网址导航
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$NODE server/index.js
Environment=NODE_ENV=production
# 端口等设置在网页的 设置 → 服务器 里改；也可以在这里加 Environment=PORT=8080 之类的行
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sleep 1
sudo systemctl --no-pager --lines=5 status "$SERVICE" || true

echo
echo "安装完成。浏览器打开 http://<这台机器的IP>:3080 设置管理密码。"
echo "常用命令：sudo systemctl restart $SERVICE    查看日志：journalctl -u $SERVICE -f"
