---
name: access-wechat
description: 管理微信 Channel 的访问控制 — 配对确认、查看/添加/移除授权用户、切换策略。用户说"配对"、"pair"、"授权"时触发。
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - mcp__wechat__access-wechat
---

# /access-wechat — 微信 Access 管理

管理谁可以通过微信向 Claude Code 发送消息。

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### `pair <code>` — 确认配对

调用 MCP tool `access-wechat`，action=`pair`，value=`<code>`。
成功后告知用户已配对，并建议检查策略。

### `list` — 查看授权

调用 MCP tool `access-wechat`，action=`list`。
显示所有已授权的用户 ID。

### `add <user_id>` — 手动添加

调用 MCP tool `access-wechat`，action=`add`，value=`<user_id>`。

### `remove <user_id>` — 移除用户

调用 MCP tool `access-wechat`，action=`remove`，value=`<user_id>`。

### No args — 显示使用帮助

```
用法:
  /access-wechat pair <code>     确认配对
  /access-wechat list            查看已授权用户
  /access-wechat add <id>        手动添加用户
  /access-wechat remove <id>     移除用户
```

---

## Security notes

- 配对码 30 分钟后过期
- 建议配对完成后将策略从 `pairing` 切换到 `allowlist`
- `access.json` 的修改即时生效，无需重启
