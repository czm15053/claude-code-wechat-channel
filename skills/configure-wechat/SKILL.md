---
name: configure-wechat
description: 配置微信 Channel — 扫码登录或查看连接状态。用户说"配置微信"、"连接微信"、"扫码登录"时触发。
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - mcp__wechat__configure-wechat
---

# /configure-wechat — 微信 Channel 配置

配置微信 iLink 连接，管理扫码登录凭证。

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — 状态检查 + 扫码登录

1. **凭证状态** — 检查 `~/.claude/channels/wechat/credentials.json`：
   - 文件存在 → 显示 accountId（脱敏），提示"已配置"
   - 文件不存在 → 提示"未配置"

2. **Access 状态** — 读取 `~/.claude/channels/wechat/access.json`：
   - 显示 dmPolicy、已授权用户数量
   - 显示 pending 配对码（如有）

3. **下一步**：
   - 未配置 → 调用 `configure-wechat` tool 发起扫码登录
   - 已配置但无授权用户 → 提示"用微信给 bot 发消息，收到配对码后运行 `/access-wechat pair <code>`"
   - 已配置且有授权用户 → 提示"就绪。发微信消息即可与 Claude Code 交互。"

4. **如果需要扫码**：
   - 调用 MCP tool `configure-wechat`
   - 告知用户查看终端 stderr 输出的二维码 URL
   - 用微信扫码确认
   - 扫码成功后提示需要重启 Claude Code 才能生效

### `status` — 仅查看状态

只做上面的步骤 1-2，不触发扫码。

### `clear` — 清除凭证

删除 `~/.claude/channels/wechat/credentials.json`，提示需要重新扫码。

---

## Implementation notes

- 状态目录 `~/.claude/channels/wechat/` 可能不存在，缺少文件 = 未配置。
- 凭证变更后需要重启 Claude Code session 或 `/reload-plugins` 才能生效。
- `access.json` 每条消息都会重新读取，策略变更即时生效。
