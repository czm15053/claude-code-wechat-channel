#!/usr/bin/env bun
/**
 * 微信消息接收测试脚本
 *
 * 用法：bun test-recv.ts
 */

import { WeChatClient, MessageType, MessageItemType } from './ilink'
import type { WeixinMessage } from './ilink'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CREDS_PATH = join(homedir(), '.claude', 'channels', 'wechat', 'credentials.json')

if (!existsSync(CREDS_PATH)) {
  console.error('❌ 未找到凭证文件，请先运行 bun login.ts')
  process.exit(1)
}

const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'))
console.log(`\n📡 使用凭证: accountId=${creds.accountId}`)
console.log(`   baseUrl: ${creds.baseUrl ?? '(默认)'}`)

const client = new WeChatClient({
  accountId: creds.accountId,
  token: creds.token,
  baseUrl: creds.baseUrl,
})

client.on('message', (msg: WeixinMessage) => {
  console.log(`\n📨 收到消息:`)
  console.log(`   type: ${msg.message_type}`)
  console.log(`   from: ${msg.from_user_id}`)
  console.log(`   context_token: ${msg.context_token?.slice(0, 20)}...`)

  const items = msg.item_list ?? []
  for (const item of items) {
    if (item.type === MessageItemType.TEXT) {
      console.log(`   text: "${item.text_item?.text}"`)
    } else {
      console.log(`   media type: ${item.type}`)
    }
  }

  const text = WeChatClient.extractText(msg)
  if (text) console.log(`   extracted text: "${text}"`)
})

client.on('error', (err: Error) => {
  console.error(`\n❌ 错误: ${err.message}`)
})

client.on('sessionExpired', () => {
  console.error('\n⚠️ Session 已过期！请重新运行 bun login.ts')
})

console.log('\n🔄 开始 long-poll，等待微信消息...')
console.log('   (按 Ctrl+C 停止)\n')

const shutdown = () => {
  console.log('\n停止...')
  client.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await client.start()
