/**
 * 微信 iLink 协议客户端（内置实现）
 *
 * 基于 iLink HTTP API 实现以下功能：
 *   - QR 扫码登录
 *   - Long-poll 消息接收
 *   - 文本消息发送
 *   - context_token 缓存
 *
 * 参考：https://github.com/photon-hq/wechat-ilink-client
 */

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'

// ═══════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_API_TIMEOUT_MS = 15_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_BOT_TYPE = '3'
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
const SESSION_EXPIRED_ERRCODE = -14

// ═══════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

export interface TextItem { text?: string }

export interface ImageItem {
  media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number }
  aeskey?: string
  url?: string
  mid_size?: number
}

export interface VoiceItem {
  media?: { encrypt_query_param?: string; aes_key?: string }
  text?: string
}

export interface FileItem {
  media?: { encrypt_query_param?: string; aes_key?: string }
  file_name?: string
  len?: string
}

export interface VideoItem {
  media?: { encrypt_query_param?: string; aes_key?: string }
  video_size?: number
}

export interface MessageItem {
  type?: number
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  msg_id?: string
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
}

interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

interface QRCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

interface QRCodeStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** X-WECHAT-UIN 请求头：随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

/** 生成唯一客户端 ID */
function generateClientId(): string {
  return `wechat-ilink-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

/** 规范化账号 ID（如 "hex@im.bot" → "hex-im-bot"） */
export function normalizeAccountId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[@.]/g, '-')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => { clearTimeout(t); reject(new Error('aborted')) },
      { once: true },
    )
  })
}

// ═══════════════════════════════════════════
// HTTP API 底层
// ═══════════════════════════════════════════

class ILinkApi {
  readonly baseUrl: string
  private token?: string

  constructor(baseUrl?: string, token?: string) {
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL
    this.token = token
  }

  setToken(t: string) { this.token = t }
  getToken() { return this.token }

  private buildHeaders(bodyStr: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
      'X-WECHAT-UIN': randomWechatUin(),
    }
    if (this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`
    }
    return headers
  }

  /** POST JSON 请求 */
  private async post(endpoint: string, body: object, timeoutMs: number): Promise<string> {
    const base = ensureTrailingSlash(this.baseUrl)
    const url = new URL(endpoint, base).toString()
    const bodyStr = JSON.stringify(body)
    const headers = this.buildHeaders(bodyStr)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method: 'POST', headers, body: bodyStr, signal: controller.signal })
      clearTimeout(timer)
      const text = await res.text()
      if (!res.ok) throw new Error(`API ${endpoint} ${res.status}: ${text}`)
      return text
    } catch (err) {
      clearTimeout(timer)
      throw err
    }
  }

  /** Long-poll 获取新消息 */
  async getUpdates(getUpdatesBuf: string, timeoutMs?: number): Promise<GetUpdatesResp> {
    const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
    try {
      const text = await this.post('ilink/bot/getupdates', {
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: 'standalone-0.1.0' },
      }, timeout)
      return JSON.parse(text) as GetUpdatesResp
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
      }
      throw err
    }
  }

  /** 发送消息 */
  async sendMessage(msg: object): Promise<void> {
    await this.post('ilink/bot/sendmessage', {
      ...msg,
      base_info: { channel_version: 'standalone-0.1.0' },
    }, DEFAULT_API_TIMEOUT_MS)
  }

  /** 获取二维码 */
  async getQRCode(botType?: string): Promise<QRCodeResponse> {
    const base = ensureTrailingSlash(this.baseUrl)
    const bt = botType ?? DEFAULT_BOT_TYPE
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(bt)}`, base)
    const res = await fetch(url.toString())
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)')
      throw new Error(`获取二维码失败: ${res.status} ${body}`)
    }
    return (await res.json()) as QRCodeResponse
  }

  /** 轮询二维码状态 */
  async pollQRCodeStatus(qrcode: string): Promise<QRCodeStatusResponse> {
    const base = ensureTrailingSlash(this.baseUrl)
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS)
    try {
      const res = await fetch(url.toString(), {
        headers: { 'iLink-App-ClientVersion': '1' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      if (!res.ok) throw new Error(`轮询二维码状态失败: ${res.status} ${text}`)
      return JSON.parse(text) as QRCodeStatusResponse
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        return { status: 'wait' }
      }
      throw err
    }
  }
}

// ═══════════════════════════════════════════
// QR 扫码登录
// ═══════════════════════════════════════════

export interface LoginResult {
  connected: boolean
  botToken?: string
  accountId?: string
  baseUrl?: string
  userId?: string
  message: string
}

export interface QRLoginOptions {
  timeoutMs?: number
  botType?: string
  maxRefreshes?: number
  onQRCode?: (qrcodeUrl: string) => void | Promise<void>
  onStatus?: (status: QRCodeStatusResponse['status']) => void
  signal?: AbortSignal
}

async function loginWithQRCode(api: ILinkApi, opts: QRLoginOptions = {}): Promise<LoginResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000)
  const maxRefreshes = opts.maxRefreshes ?? 3
  const deadline = Date.now() + timeoutMs
  let refreshCount = 1

  // 获取初始二维码
  const qrResponse = await api.getQRCode(opts.botType)
  let qrcode = qrResponse.qrcode

  if (opts.onQRCode) {
    await opts.onQRCode(qrResponse.qrcode_img_content)
  }

  // 轮询直到确认、过期或超时
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { connected: false, message: '登录已取消' }
    }

    const status = await api.pollQRCodeStatus(qrcode)
    opts.onStatus?.(status.status)

    switch (status.status) {
      case 'wait':
      case 'scaned':
        break
      case 'expired': {
        refreshCount++
        if (refreshCount > maxRefreshes) {
          return { connected: false, message: `二维码已过期 ${maxRefreshes} 次，请重新登录` }
        }
        const refreshed = await api.getQRCode(opts.botType)
        qrcode = refreshed.qrcode
        if (opts.onQRCode) await opts.onQRCode(refreshed.qrcode_img_content)
        break
      }
      case 'confirmed': {
        if (!status.ilink_bot_id) {
          return { connected: false, message: '登录确认但服务器未返回 bot ID' }
        }
        return {
          connected: true,
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl,
          userId: status.ilink_user_id,
          message: '登录成功！',
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  return { connected: false, message: '登录超时' }
}

// ═══════════════════════════════════════════
// Long-poll 监控循环
// ═══════════════════════════════════════════

interface MonitorOptions {
  signal?: AbortSignal
  loadSyncBuf?: () => string | undefined | Promise<string | undefined>
  saveSyncBuf?: (buf: string) => void | Promise<void>
}

interface MonitorCallbacks {
  onMessage: (msg: WeixinMessage) => void | Promise<void>
  onError?: (err: Error) => void
  onSessionExpired?: () => void
  onPoll?: (resp: GetUpdatesResp) => void
}

async function startMonitor(api: ILinkApi, opts: MonitorOptions, callbacks: MonitorCallbacks): Promise<void> {
  const { signal } = opts

  // 加载持久化游标
  let getUpdatesBuf = ''
  if (opts.loadSyncBuf) {
    const loaded = await opts.loadSyncBuf()
    if (loaded) getUpdatesBuf = loaded
  }

  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS
  let consecutiveFailures = 0

  while (!signal?.aborted) {
    try {
      const resp = await api.getUpdates(getUpdatesBuf, nextTimeoutMs)

      // 服务器建议的超时时间
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms
      }

      // 检查 API 错误
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0)

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE ||
          resp.ret === SESSION_EXPIRED_ERRCODE

        if (isSessionExpired) {
          callbacks.onSessionExpired?.()
          await sleep(60 * 60 * 1000, signal) // 暂停 1 小时
          consecutiveFailures = 0
          continue
        }

        consecutiveFailures++
        callbacks.onError?.(
          new Error(`getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`),
        )

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0
          await sleep(BACKOFF_DELAY_MS, signal)
        } else {
          await sleep(RETRY_DELAY_MS, signal)
        }
        continue
      }

      // 成功
      consecutiveFailures = 0
      callbacks.onPoll?.(resp)

      // 持久化游标
      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        getUpdatesBuf = resp.get_updates_buf
        if (opts.saveSyncBuf) await opts.saveSyncBuf(getUpdatesBuf)
      }

      // 分发消息
      for (const msg of (resp.msgs ?? [])) {
        await callbacks.onMessage(msg)
      }
    } catch (err) {
      if (signal?.aborted) return
      consecutiveFailures++
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0
        await sleep(BACKOFF_DELAY_MS, signal)
      } else {
        await sleep(RETRY_DELAY_MS, signal)
      }
    }
  }
}

// ═══════════════════════════════════════════
// WeChatClient 主类
// ═══════════════════════════════════════════

export interface WeChatClientOptions {
  baseUrl?: string
  token?: string
  accountId?: string
}

export class WeChatClient extends EventEmitter {
  private api: ILinkApi
  private accountId?: string
  private abortController?: AbortController
  private contextTokens = new Map<string, string>()

  constructor(opts: WeChatClientOptions = {}) {
    super()
    this.api = new ILinkApi(opts.baseUrl, opts.token)
    this.accountId = opts.accountId
  }

  // ── QR 登录 ──────────────────────────────

  async login(opts: QRLoginOptions = {}): Promise<LoginResult> {
    const result = await loginWithQRCode(this.api, opts)
    if (result.connected && result.botToken && result.accountId) {
      this.accountId = normalizeAccountId(result.accountId)
      this.api.setToken(result.botToken)
    }
    return result
  }

  // ── Long-poll ────────────────────────────

  async start(opts: Omit<MonitorOptions, 'signal'> = {}): Promise<void> {
    if (!this.accountId) throw new Error('未设置 accountId，请先登录')
    if (!this.api.getToken()) throw new Error('未设置 token，请先登录')

    this.abortController = new AbortController()

    await startMonitor(this.api, { signal: this.abortController.signal, ...opts }, {
      onMessage: async (msg) => {
        // 缓存 context_token
        if (msg.context_token && msg.from_user_id) {
          this.contextTokens.set(msg.from_user_id, msg.context_token)
        }
        this.emit('message', msg)
      },
      onError: (err) => this.emit('error', err),
      onSessionExpired: () => this.emit('sessionExpired'),
      onPoll: (resp) => this.emit('poll', resp),
    })
  }

  stop(): void {
    this.abortController?.abort()
    this.abortController = undefined
  }

  // ── 发送文本消息 ──────────────────────────

  async sendText(to: string, text: string, contextToken?: string): Promise<string> {
    const ct = contextToken ?? this.contextTokens.get(to)
    if (!ct) throw new Error(`用户 ${to} 没有缓存的 context_token，需要先收到该用户的消息`)

    const clientId = generateClientId()
    await this.api.sendMessage({
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
        context_token: ct,
      },
    })
    return clientId
  }

  // ── 静态工具方法 ──────────────────────────

  /** 提取消息文本 */
  static extractText(msg: WeixinMessage): string {
    if (!msg.item_list?.length) return ''
    for (const item of msg.item_list) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
        return String(item.text_item.text)
      }
      // 语音转文字
      if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
        return item.voice_item.text
      }
    }
    return ''
  }

  /** 检查是否为媒体消息项 */
  static isMediaItem(item: MessageItem): boolean {
    return (
      item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.VIDEO ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VOICE
    )
  }
}
