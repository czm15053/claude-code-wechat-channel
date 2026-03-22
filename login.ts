#!/usr/bin/env bun
/**
 * 微信扫码登录脚本
 *
 * 独立运行，不需要 Claude Code。
 * 扫码成功后凭证保存到 ~/.claude/channels/wechat/credentials.json
 *
 * 用法：
 *   bun login.ts
 */

import {
  WeChatClient,
  normalizeAccountId,
} from 'wechat-ilink-client'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const CREDS_PATH = join(STATE_DIR, 'credentials.json')

mkdirSync(STATE_DIR, { recursive: true })

// 检查是否已有凭证
if (existsSync(CREDS_PATH)) {
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'))
  console.log(`\n已有保存的凭证：`)
  console.log(`  accountId: ${creds.accountId}`)
  console.log(`  凭证文件: ${CREDS_PATH}`)
  console.log(`\n如需重新登录，请删除凭证文件后再运行：`)
  console.log(`  rm ${CREDS_PATH}`)
  console.log(`  bun login.ts\n`)
  process.exit(0)
}

console.log('\n🔐 微信 iLink 扫码登录\n')

const client = new WeChatClient()

try {
  const result = await client.login({
    timeoutMs: 5 * 60_000,
    onQRCode(url) {
      console.log('请用微信扫描以下二维码链接：\n')
      console.log(`  ${url}\n`)

      // 尝试用 qrcode-terminal 渲染
      try {
        const qrt = require('qrcode-terminal')
        qrt.generate(url, { small: true })
      } catch {
        console.log('(安装 qrcode-terminal 可在终端直接显示二维码)')
      }
    },
    onStatus(status) {
      switch (status) {
        case 'scaned':
          console.log('✅ 已扫码，请在手机上确认...')
          break
        case 'expired':
          console.log('⏰ 二维码已过期，刷新中...')
          break
        case 'confirmed':
          console.log('🎉 登录确认成功！')
          break
      }
    },
  })

  if (!result.connected) {
    console.error(`\n❌ 登录失败: ${result.message}`)
    process.exit(1)
  }

  // 保存凭证
  const creds = {
    accountId: normalizeAccountId(result.accountId!),
    token: result.botToken!,
    baseUrl: result.baseUrl,
    userId: result.userId,
  }

  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n')

  console.log(`\n✅ 登录成功！`)
  console.log(`  accountId: ${creds.accountId}`)
  console.log(`  凭证已保存到: ${CREDS_PATH}`)
  console.log(`\n现在可以启动 Claude Code 使用微信 Channel 了：`)
  console.log(`  cd ${process.cwd()}`)
  console.log(`  claude --add-dir ./ --dangerously-load-development-channels server:wechat\n`)
} catch (err) {
  console.error(`\n❌ 登录异常: ${err}`)
  process.exit(1)
}
