#!/usr/bin/env bash
# 在 macOS 上把网址导航装成 launchd 用户服务：登录后自动启动，退出后自动重启。
# 用法：在项目目录里执行  bash deploy/install-macos.sh
# 卸载：bash deploy/install-macos.sh uninstall
set -euo pipefail

LABEL=com.nav.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载服务。数据还在 $DIR/data，需要的话请自行删除。"
  exit 0
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

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>server/index.js</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/nav.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/nav.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo
echo "安装完成。浏览器打开 http://localhost:3080 设置管理密码。"
echo "日志在 $DIR/data/nav.log    重启：launchctl kickstart -k gui/$(id -u)/$LABEL"
