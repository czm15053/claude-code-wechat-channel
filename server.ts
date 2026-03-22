#!/usr/bin/env bun
/**
 * 微信 Channel for Claude Code
 *
 * 通过微信 iLink 协议（long-poll）接收消息，
 * 通过 MCP Channel 协议转发给 Claude Code。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  WeChatClient,
  normalizeAccountId,
  MessageType,
  MessageItemType,
} from 'wechat-ilink-client'
import type { WeixinMessage, MessageItem } from 'wechat-ilink-client'
import { join } from 'path'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const STATE_DIR =
  process.env.WECHAT_STATE_DIR ??
  join(homedir(), '.claude', 'channels', 'wechat')

const CREDS_PATH = join(STATE_DIR, 'credentials.json')
const SYNC_BUF_PATH = join(STATE_DIR, 'sync-buf.json')
const ACCESS_PATH = join(STATE_DIR, 'access.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const DEBUG_LOG = join(STATE_DIR, 'debug.log')

mkdirSync(STATE_DIR, { recursive: true })

// 调试日志写到文件
import { appendFileSync } from 'fs'
function dbg(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] ${msg}\n`
  try { appendFileSync(DEBUG_LOG, line) } catch {}
  process.stderr.write(`wechat: ${msg}\n`)
}

dbg('=== server.ts 启动 ===')

// ═══════════════════════════════════════════
// 凭证持久化
// ═══════════════════════════════════════════

interface SavedCredentials {
  accountId: string
  token: string
  baseUrl?: string
  userId?: string
}

function loadCredentials(): SavedCredentials | null {
  try {
    if (existsSync(CREDS_PATH)) {
      return JSON.parse(readFileSync(CREDS_PATH, 'utf-8'))
    }
  } catch {}
  return null
}

function saveCredentials(creds: SavedCredentials): void {
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n')
}

// ═══════════════════════════════════════════
// 同步游标持久化
// ═══════════════════════════════════════════

function loadSyncBuf(): string | undefined {
  try {
    if (existsSync(SYNC_BUF_PATH)) {
      const data = JSON.parse(readFileSync(SYNC_BUF_PATH, 'utf-8'))
      return data.buf
    }
  } catch {}
  return undefined
}

function saveSyncBuf(buf: string): void {
  writeFileSync(SYNC_BUF_PATH, JSON.stringify({ buf }) + '\n')
}

// ═══════════════════════════════════════════
// Access Control（配对 + allowlist）
// ═══════════════════════════════════════════

interface PendingPairing {
  senderId: string
  senderName: string
  ts: number
}

interface AccessConfig {
  /** 处理未知发送者的策略：pairing（默认）| allowlist | disabled */
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** 允许发消息的用户 ID 列表 */
  allowFrom: string[]
  /** 待配对的条目 {code: PendingPairing} */
  pending: Record<string, PendingPairing>
  /** 消息长度限制 */
  textChunkLimit: number
}

const DEFAULT_ACCESS: AccessConfig = {
  dmPolicy: 'pairing',
  allowFrom: [],
  pending: {},
  textChunkLimit: 2000,
}

function loadAccess(): AccessConfig {
  try {
    if (existsSync(ACCESS_PATH)) {
      const raw = JSON.parse(readFileSync(ACCESS_PATH, 'utf-8'))
      return { ...DEFAULT_ACCESS, ...raw }
    }
  } catch (err) {
    process.stderr.write(`wechat channel: 读取 access.json 失败: ${err}\n`)
  }
  return { ...DEFAULT_ACCESS }
}

function saveAccess(access: AccessConfig): void {
  writeFileSync(ACCESS_PATH, JSON.stringify(access, null, 2) + '\n')
}

function generatePairingCode(): string {
  return randomBytes(3).toString('hex')
}

type GateResult =
  | { action: 'pass'; access: AccessConfig }
  | { action: 'pair'; code: string; isResend: boolean }
  | { action: 'drop' }

function gate(senderId: string, senderName: string): GateResult {
  const access = loadAccess()

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (access.allowFrom.includes(senderId)) {
    return { action: 'pass', access }
  }

  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  // pairing 策略
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      return { action: 'pair', code, isResend: true }
    }
  }

  // 清理超过 30 分钟的 pending
  const now = Date.now()
  for (const [code, p] of Object.entries(access.pending)) {
    if (now - p.ts > 30 * 60 * 1000) {
      delete access.pending[code]
    }
  }

  const code = generatePairingCode()
  access.pending[code] = { senderId, senderName, ts: now }
  saveAccess(access)

  return { action: 'pair', code, isResend: false }
}

// ═══════════════════════════════════════════
// MCP Server
// ═══════════════════════════════════════════

const mcp = new Server(
  { name: 'wechat', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      '微信消息以 <channel source="wechat" user_id="..." user="..." ...> 格式到达。' +
      '使用 reply 工具回复，传入 meta 中的 user_id 和要发送的 text。' +
      '微信用户 ID 是 iLink 格式的十六进制 ID。',
  },
)

// ═══════════════════════════════════════════
// 微信客户端
// ═══════════════════════════════════════════

let wechatClient: WeChatClient | null = null

// ═══════════════════════════════════════════
// MCP Tools
// ═══════════════════════════════════════════

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        '通过微信发送回复消息。user_id 来自 <channel> 标签的 meta。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: {
            type: 'string',
            description: '微信用户 ID（来自 channel 事件的 user_id）',
          },
          text: {
            type: 'string',
            description: '要发送的消息文本',
          },
        },
        required: ['user_id', 'text'],
      },
    },
    {
      name: 'configure-wechat',
      description:
        '触发微信扫码登录。首次使用或 session 过期时调用。',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'access-wechat',
      description:
        '管理微信 access 控制。pair <code> 确认配对；list 列出已授权用户；add/remove 添加/移除用户。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            description: 'pair / list / add / remove',
          },
          value: {
            type: 'string',
            description: '配对码或用户 ID',
          },
        },
        required: ['action'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params

  // ── reply ────────────────────────────────
  if (name === 'reply') {
    const { user_id, text } = req.params.arguments as {
      user_id: string
      text: string
    }

    if (!wechatClient) {
      return {
        content: [{ type: 'text', text: '微信未连接，请先运行 /configure-wechat' }],
        isError: true,
      }
    }

    try {
      const access = loadAccess()
      const chunks = splitText(text, access.textChunkLimit)

      for (const chunk of chunks) {
        await wechatClient.sendText(user_id, chunk)
      }

      return { content: [{ type: 'text', text: 'sent' }] }
    } catch (err) {
      const errMsg = `发送失败: ${err}`
      process.stderr.write(`wechat channel: ${errMsg}\n`)
      return { content: [{ type: 'text', text: errMsg }], isError: true }
    }
  }

  // ── configure-wechat ────────────────────
  if (name === 'configure-wechat') {
    try {
      const result = await doLogin()
      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `登录失败: ${err}` }],
        isError: true,
      }
    }
  }

  // ── access-wechat ───────────────────────
  if (name === 'access-wechat') {
    const { action, value } = req.params.arguments as {
      action: string
      value?: string
    }
    return handleAccessControl(action, value)
  }

  throw new Error(`unknown tool: ${name}`)
})

// ═══════════════════════════════════════════
// Access Control 操作
// ═══════════════════════════════════════════

function handleAccessControl(
  action: string,
  value?: string,
): { content: { type: string; text: string }[] } {
  const access = loadAccess()

  if (action === 'pair') {
    if (!value) {
      return { content: [{ type: 'text', text: '用法: access-wechat pair <code>' }] }
    }
    const pending = access.pending[value]
    if (!pending) {
      return { content: [{ type: 'text', text: `配对码 ${value} 不存在或已过期` }] }
    }

    // 添加到 allowlist
    if (!access.allowFrom.includes(pending.senderId)) {
      access.allowFrom.push(pending.senderId)
    }
    delete access.pending[value]
    saveAccess(access)

    // 写入 approved 文件，通知用户
    const approvedDir = join(STATE_DIR, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    writeFileSync(join(approvedDir, value), pending.senderId)

    return {
      content: [{
        type: 'text',
        text: `✅ 已配对用户 ${pending.senderName} (${pending.senderId})`,
      }],
    }
  }

  if (action === 'list') {
    const list = access.allowFrom.length
      ? access.allowFrom.join('\n')
      : '(空)'
    return { content: [{ type: 'text', text: `已授权用户:\n${list}` }] }
  }

  if (action === 'add' && value) {
    if (!access.allowFrom.includes(value)) {
      access.allowFrom.push(value)
      saveAccess(access)
    }
    return { content: [{ type: 'text', text: `已添加 ${value}` }] }
  }

  if (action === 'remove' && value) {
    access.allowFrom = access.allowFrom.filter((id) => id !== value)
    saveAccess(access)
    return { content: [{ type: 'text', text: `已移除 ${value}` }] }
  }

  return { content: [{ type: 'text', text: '用法: pair|list|add|remove [value]' }] }
}

// ═══════════════════════════════════════════
// 文本分块
// ═══════════════════════════════════════════

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cutAt = remaining.lastIndexOf('\n\n', limit)
    if (cutAt < limit * 0.3) cutAt = remaining.lastIndexOf('\n', limit)
    if (cutAt < limit * 0.3) cutAt = limit
    chunks.push(remaining.slice(0, cutAt).trimEnd())
    remaining = remaining.slice(cutAt).trimStart()
  }
  if (remaining) chunks.push(remaining)

  return chunks
}

// ═══════════════════════════════════════════
// 微信消息处理
// ═══════════════════════════════════════════

/**
 * 处理微信入站消息
 */
async function handleInbound(
  senderId: string,
  senderName: string,
  text: string,
  imagePath?: string,
): Promise<void> {
  const result = gate(senderId, senderName)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? '仍在等待配对' : '需要配对'
    const replyText =
      `${lead} — 在 Claude Code 中运行:\n\n/access-wechat pair ${result.code}`
    try {
      await wechatClient?.sendText(senderId, replyText)
    } catch (err) {
      process.stderr.write(`wechat channel: 发送配对码失败: ${err}\n`)
    }
    return
  }

  // 发送 channel notification 给 Claude Code
  const displayText = imagePath ? '(图片)' : text || '(空消息)'

  mcp
    .notification({
      method: 'notifications/claude/channel',
      params: {
        content: displayText,
        meta: {
          user_id: senderId,
          user: senderName,
          ts: new Date().toISOString(),
          ...(imagePath ? { image_path: imagePath } : {}),
        },
      },
    })
    .catch((err) => {
      process.stderr.write(
        `wechat channel: 投递消息到 Claude 失败: ${err}\n`,
      )
    })
}

// ═══════════════════════════════════════════
// 图片下载
// ═══════════════════════════════════════════

async function downloadMedia(
  item: MessageItem,
): Promise<string | undefined> {
  if (!wechatClient) return undefined
  try {
    const downloaded = await wechatClient.downloadMedia(item)
    if (!downloaded) return undefined

    mkdirSync(INBOX_DIR, { recursive: true })
    const ext =
      downloaded.kind === 'image' ? '.jpg' :
      downloaded.kind === 'video' ? '.mp4' :
      downloaded.kind === 'voice' ? '.silk' : '.bin'
    const path = join(INBOX_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`)
    writeFileSync(path, downloaded.data)
    return path
  } catch (err) {
    process.stderr.write(`wechat channel: 媒体下载失败: ${err}\n`)
    return undefined
  }
}

// ═══════════════════════════════════════════
// QR 扫码登录
// ═══════════════════════════════════════════

async function doLogin(): Promise<string> {
  const client = new WeChatClient()

  const result = await client.login({
    timeoutMs: 5 * 60_000,
    onQRCode(url) {
      // 输出二维码 URL 到 stderr（用户可以在终端看到）
      process.stderr.write(
        `\n` +
        `╔══════════════════════════════════════════╗\n` +
        `║       微信扫码登录                       ║\n` +
        `╠══════════════════════════════════════════╣\n` +
        `║  请用微信扫描以下链接的二维码：           ║\n` +
        `║  ${url}\n` +
        `╚══════════════════════════════════════════╝\n\n`,
      )
    },
    onStatus(status) {
      switch (status) {
        case 'scaned':
          process.stderr.write('wechat channel: 已扫码，等待确认...\n')
          break
        case 'expired':
          process.stderr.write('wechat channel: 二维码已过期，刷新中...\n')
          break
        case 'confirmed':
          process.stderr.write('wechat channel: 登录确认成功！\n')
          break
      }
    },
  })

  if (!result.connected) {
    throw new Error(result.message)
  }

  // 持久化凭证
  saveCredentials({
    accountId: normalizeAccountId(result.accountId!),
    token: result.botToken!,
    baseUrl: result.baseUrl,
    userId: result.userId,
  })

  wechatClient = client
  startMessageLoop()

  return `✅ 微信登录成功！账号: ${result.accountId}`
}

// ═══════════════════════════════════════════
// 消息循环
// ═══════════════════════════════════════════

function startMessageLoop(): void {
  if (!wechatClient) return

  wechatClient.on('message', async (msg: WeixinMessage) => {
    try {
      process.stderr.write(`wechat channel: [DEBUG] 收到消息 type=${msg.message_type} from=${msg.from_user_id}\n`)

      // 只处理用户消息
      if (msg.message_type !== MessageType.USER) {
        process.stderr.write(`wechat channel: [DEBUG] 跳过非用户消息 type=${msg.message_type}\n`)
        return
      }

      const senderId = msg.from_user_id ?? '(unknown)'
      const senderName = senderId // iLink 没有用户名，用 ID 代替
      const items = msg.item_list ?? []

      // 提取文本
      const text = WeChatClient.extractText(msg)
      process.stderr.write(`wechat channel: [DEBUG] 用户消息 from=${senderId} text="${text?.slice(0, 50)}"\n`)

      // 处理媒体
      let imagePath: string | undefined
      const mediaItems = items.filter((i) => WeChatClient.isMediaItem(i))
      if (mediaItems.length > 0) {
        imagePath = await downloadMedia(mediaItems[0])
      }

      await handleInbound(senderId, senderName, text, imagePath)
    } catch (err) {
      process.stderr.write(`wechat channel: 消息处理错误: ${err}\n`)
    }
  })

  wechatClient.on('error', (err: Error) => {
    process.stderr.write(`wechat channel: 轮询错误: ${err.message}\n`)
  })

  wechatClient.on('sessionExpired', () => {
    process.stderr.write(
      'wechat channel: ⚠️ Session 已过期！请运行 /configure-wechat 重新扫码登录\n',
    )
  })

  wechatClient.on('poll', (resp: any) => {
    const msgCount = resp.msgs?.length ?? 0
    if (msgCount > 0) {
      process.stderr.write(`wechat channel: [DEBUG] poll 返回 ${msgCount} 条消息\n`)
    }
  })

  // 启动 long-poll
  process.stderr.write('wechat channel: [DEBUG] 正在启动 long-poll...\n')
  wechatClient
    .start({ loadSyncBuf, saveSyncBuf })
    .then(() => {
      process.stderr.write('wechat channel: [DEBUG] long-poll 循环结束\n')
    })
    .catch((err) => {
      process.stderr.write(`wechat channel: long-poll 启动失败: ${err}\n`)
    })

  process.stderr.write('wechat channel: 消息循环已启动\n')
}

// ═══════════════════════════════════════════
// 配对确认轮询
// ═══════════════════════════════════════════

const APPROVED_DIR = join(STATE_DIR, 'approved')

function pollApproved(): void {
  try {
    if (!existsSync(APPROVED_DIR)) return
    const files: string[] = readdirSync(APPROVED_DIR)
    for (const code of files) {
      if (code.startsWith('.')) continue
      const filePath = join(APPROVED_DIR, code)
      try {
        const userId = readFileSync(filePath, 'utf-8').trim()
        unlinkSync(filePath)
        if (userId && wechatClient) {
          wechatClient
            .sendText(userId, '✅ 配对成功！你发送的消息将被转发到 Claude Code 会话。')
            .catch((err: Error) => {
              process.stderr.write(
                `wechat channel: 发送配对确认失败: ${err}\n`,
              )
            })
        }
      } catch (err) {
        process.stderr.write(`wechat channel: 处理配对确认失败: ${err}\n`)
      }
    }
  } catch {
    // approved 目录不存在或无法读取
  }
}

setInterval(pollApproved, 2000)

// ═══════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════

// 1. 连接 MCP（Claude Code 通过 stdio 与本进程通信）
dbg('MCP connecting...')
await mcp.connect(new StdioServerTransport())
dbg('MCP connected!')

// 2. 尝试从保存的凭证恢复微信连接
const savedCreds = loadCredentials()
if (savedCreds) {
  dbg(`发现凭证 accountId=${savedCreds.accountId}`)
  wechatClient = new WeChatClient({
    accountId: savedCreds.accountId,
    token: savedCreds.token,
    baseUrl: savedCreds.baseUrl,
  })
  dbg('WeChatClient 创建完成，启动消息循环...')
  startMessageLoop()
} else {
  dbg('未找到凭证')
}

dbg('server.ts 启动完成')
