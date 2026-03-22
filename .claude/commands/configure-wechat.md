配置微信 Channel 连接。

Arguments: $ARGUMENTS

## 执行步骤

1. 先检查凭证状态：

```bash
ls -la ~/.claude/channels/wechat/credentials.json 2>/dev/null && echo "已配置" || echo "未配置"
```

```bash
cat ~/.claude/channels/wechat/access.json 2>/dev/null || echo "无 access 配置"
```

2. 如果未配置（credentials.json 不存在），告知用户：

> 微信 Channel 未配置。需要扫码登录。
>
> 请**在另一个终端窗口**运行以下命令发起扫码：
>
> ```bash
> cd /Users/zmc/Desktop/cc/wechat-channel && bun server.ts 2>&1 | head -20
> ```
>
> 或者直接使用 MCP tool `configure-wechat`（如果可用）来发起扫码登录。
> 
> 扫码成功后，**重启 Claude Code** 以加载新凭证。

3. 如果已配置，读取 credentials.json 显示 accountId（脱敏），提示已就绪。

4. 如果已配置但无授权用户：
   - 提示"用微信给 bot 发消息，收到配对码后运行 `/access-wechat pair <code>`"

5. 使用 MCP tool `configure-wechat` 发起扫码（如果该 tool 可用），否则提示用户手动运行命令。
