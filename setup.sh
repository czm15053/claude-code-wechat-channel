#!/usr/bin/env bash
# 微信 Channel for Claude Code — 安装脚本
#
# 用法：
#   ./setup.sh
#
# 功能：
#   1. 检测 bun 路径
#   2. 生成 .mcp.json（使用当前机器的绝对路径）
#   3. 安装依赖
#   4. 构建 wechat-ilink-client（如需要）

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

# 2. 检测 wechat-ilink-client
ILINK_DIR="$SCRIPT_DIR/../wechat-ilink-client"
if [ ! -d "$ILINK_DIR" ]; then
  echo "📥 克隆 wechat-ilink-client..."
  git clone https://github.com/photon-hq/wechat-ilink-client.git "$ILINK_DIR"
fi

# 3. 构建 wechat-ilink-client
if [ ! -f "$ILINK_DIR/dist/index.mjs" ]; then
  echo "🔨 构建 wechat-ilink-client..."
  cd "$ILINK_DIR"
  npm install --registry https://registry.npmmirror.com 2>/dev/null || npm install
  npm run build
  cd "$SCRIPT_DIR"
fi
echo "✅ wechat-ilink-client: $ILINK_DIR"

# 4. 安装依赖
echo "📦 安装依赖..."
cd "$SCRIPT_DIR"
npm install --registry https://registry.npmmirror.com 2>/dev/null || npm install

# 5. 生成 .mcp.json
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

# 6. 创建状态目录
mkdir -p "$HOME/.claude/channels/wechat"

echo ""
echo "🎉 安装完成！"
echo ""
echo "下一步："
echo "  1. 扫码登录:  cd $SCRIPT_DIR && bun login.ts"
echo "  2. 启动:      claude --add-dir $SCRIPT_DIR --dangerously-load-development-channels server:wechat"
echo ""
