配置微信 Channel 连接。

Arguments: $ARGUMENTS

## 执行步骤

1. 检查 `~/.claude/channels/wechat/credentials.json` 是否存在
   - 存在 → 显示 accountId，提示"已配置"
   - 不存在 → 提示"未配置"

2. 检查 `~/.claude/channels/wechat/access.json`
   - 显示 dmPolicy 和已授权用户

3. 如果未配置或用户要求重新登录：
   - 调用 `configure-wechat` tool 发起扫码
   - 告知用户查看终端 stderr 的二维码 URL
   - 用微信扫码确认

4. 如果已配置但无授权用户：
   - 提示"用微信给 bot 发消息，收到配对码后运行 `/access-wechat pair <code>`"

5. 凭证变更后需重启 Claude Code 才能生效
