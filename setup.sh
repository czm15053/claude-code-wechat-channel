#!/usr/bin/env bash
# 微信 Channel for Claude Code — 安装脚本
#
# 用法：./setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "")"

echo "🔧 微信 Channel 安装脚本"
echo ""

# 1. 检测 bun
if [ -z "$BUN_PATH" ]; then
  echo "❌ 未找到 bun，请先安装: https://bun.sh"
  exit 1
fi
echo "✅ bun: $BUN_PATH"

# 2. 安装依赖
echo "📦 安装依赖..."
cd "$SCRIPT_DIR"
npm install --registry https://registry.npmmirror.com 2>/dev/null || npm install

# 3. 生成 .mcp.json
cat > "$SCRIPT_DIR/.mcp.json" << EOF
{
  "mcpServers": {
    "wechat": {
      "command": "$BUN_PATH",
      "args": ["server.ts"],
      "cwd": "$SCRIPT_DIR"
    }
  }
}
EOF
echo "✅ .mcp.json 已生成"

# 4. 创建状态目录
mkdir -p "$HOME/.claude/channels/wechat"

echo ""
echo "🎉 安装完成！"
echo ""
echo "下一步："
echo "  1. 扫码登录:  cd $SCRIPT_DIR && bun login.ts"
echo "  2. 启动:      claude --add-dir $SCRIPT_DIR --dangerously-load-development-channels server:wechat"
echo ""
