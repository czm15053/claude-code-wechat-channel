管理微信 Channel 的 access 控制。

Arguments: $ARGUMENTS

## 用法

- `/access-wechat pair <code>` — 确认配对码
- `/access-wechat list` — 查看已授权用户
- `/access-wechat add <user_id>` — 手动添加
- `/access-wechat remove <user_id>` — 移除用户

## 执行

根据 $ARGUMENTS 解析 action 和 value，调用 MCP tool `access-wechat`：

1. `pair <code>` → action=pair, value=code
2. `list` → action=list
3. `add <id>` → action=add, value=id
4. `remove <id>` → action=remove, value=id
5. 无参数 → 显示用法帮助
