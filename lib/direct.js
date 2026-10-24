/**
 * 直连适配器：把 DSH 的模型请求以 Anthropic Messages 协议直接发往 ZCode Start Plan
 * 计划端点——不经 agent，DSH 的系统提示、工具、权限体系原生生效（结构化 tool_use
 * 直接回 DSH 执行），即"像正常 API 一样用"。
 *
 * 端点对请求形状有强校验（zcode.z.ai 对不合形状的请求回 405/3012 "unusual
 * activity"，magpie-community/plugins 包 zcode 的 #343 同款发现；本仓库直连实验
 * 逐一复现过）：
 *   - system 恰好三块：块 0/1 逐字节等于 ZCode 原文（lib/zcode-prompt.js 快照），
 *     块 3 = 动态段（before + 环境 + after + DSH 的系统提示）；
 *   - 头集精确等于 ZCode 3.16.3 的（只有 Authorization Bearer，agent/SDK 注入的
 *     anthropic-beta、x-stainless-* 等一律不带）；
 *   - 首条用户消息是 <system-reminder> 当天日期；metadata.user_id 带登录绑定的
 *     设备号（X-Device-Mid 同源，见 lib/device.js）；
 *   - start-plan 通道无需任何签名（V4 签名只服务 API-key 型 coding-plan 通道，
 *     见 vendor bundle 的 QUs / 本仓库直连实验）。
 *
 * 流式翻译遵循 Harness 的流协议（与 @deepseek-ai/dsh-llm-deepseek 一致）：
 * block-start / text-delta / reasoning-delta / tool-call-delta / block-end /
 * usage / finish(replayState)。
 *
 * @module lib/direct.js
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { platform as osPlatform, release as osRelease, arch as osArch } from 'node:os'

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

import { readZaiPlanAuth, CredentialError } from './credentials.js'
import { BLOCK0, BLOCK1, BEFORE_ENVIRONMENT, ENVIRONMENT, AFTER_ENVIRONMENT, CONTEXT_FIRST } from './zcode-prompt.js'

const START_BASE = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic'
const APP_VERSION = '3.16.3'
const UA = `ZCode/${APP_VERSION}`

/** 直连通道的模型清单（上下文 / max 输出 / 可选推理档位，实测于 Start Plan 端点）。 */
export const DIRECT_MODELS = [
  { id: 'GLM-5.3', context: 1_000_000, output: 128_000, efforts: ['low', 'high', 'max'] },
  { id: 'GLM-5.3-Flash', context: 1_000_000, output: 128_000, efforts: ['low', 'high', 'max'] },
  { id: 'GLM-5.2', context: 1_000_000, output: 128_000, efforts: ['none', 'high', 'max'] },
  { id: 'GLM-5-Turbo', context: 200_000, output: 64_000, efforts: ['none', 'high'] },
]

/** reasoningEffort → Anthropic thinking 预算（magpie 插件同款）。 */
const THINKING_BUDGET = { minimal: 1024, low: 4096, medium: 8192, high: 16_000, max: 31_999 }

const BLOCKED_HINT =
  'ZCode Start Plan 端点拒绝了该请求（405/3012，形状校验未过或 IP 被风控）。' +
  '可重试一次；若持续出现，改用 provider "zcode-cli"（agent 通道）。'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 本机设备号：首次生成后持久化（与 magpie 同款——服务端只要求"在"，不绑定登录设备）。 */
export function readOrCreateDevice(dataBaseDir) {
  const base = dataBaseDir?.trim?.() || process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir()
  const file = path.join(base, '.zcode', 'v2', 'dsh-zcode-cli-proxy-device.json')
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof saved?.device === 'string' && /^[0-9a-f-]{36}$/.test(saved.device)) return saved.device
  } catch {
    /* 首次：生成 */
  }
  const device = randomUUID()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ device }, null, 2)}\n`)
  } catch {
    /* 只读环境：本次进程内用临时设备号 */
  }
  return device
}

/** 今天，YYYY-MM-DD（端点的 contextPrefix 用本地日期）。 */
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** Start Plan 请求头：ZCode 3.16.3 同款，多一个都不带。 */
export function startHeaders(jwt) {
  const intl = Intl.DateTimeFormat().resolvedOptions()
  const out = {
    'content-type': 'application/json',
    'authorization': `Bearer ${jwt}`,
    'anthropic-version': '2023-06-01',
    'http-referer': 'https://zcode.z.ai',
    'user-agent': `${UA} ai-sdk/anthropic/3.0.81`,
    'x-zcode-app-version': APP_VERSION,
    'x-title': 'Z Code@cli',
    'x-release-channel': 'production',
    'x-client-language': intl.locale || 'unknown',
    'x-client-timezone': intl.timeZone || 'unknown',
    'x-zcode-agent': 'glm',
    'x-platform': `${osPlatform()}-${osArch()}`,
    'x-os-category': osPlatform() === 'darwin' ? 'macos' : osPlatform() === 'win32' ? 'windows' : 'linux',
    'x-os-version': osRelease(),
    'x-request-id': randomUUID(),
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': randomUUID(),
    'x-zcode-query-source': 'main_turn',
  }
  return out
}

/** reasoningEffort → 请求体推理配置（thinking + output_config.effort）。
 * 空值按 max（GLM-5.3 系始终思考，不支持关闭——实测端点 1210 错误）；none/off 显式关闭。 */
export function reasoningConfig(effort) {
  const level = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  if (level === 'none' || level === 'off' || level === 'disabled') {
    return { thinking: { type: 'disabled' } }
  }
  const effective = ['low', 'medium', 'high', 'xhigh', 'max'].includes(level) ? level : 'max'
  return { thinking: { type: 'enabled' }, output_config: { effort: effective } }
}

/** DSH ToolSchema → Anthropic tool（defer_loading 不发：Start Plan 不认）。 */
function toolOf(schema) {
  if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') return undefined
  return {
    name: schema.name,
    description: typeof schema.description === 'string' ? schema.description : '',
    input_schema: schema.parameters !== null && typeof schema.parameters === 'object' ? schema.parameters : { type: 'object', properties: {} },
  }
}

/** DSH 消息历史 → Anthropic messages（tool-call/tool-result/thinking 按协议映射）。 */
export function mapMessages(messages = [], { imageText, imageSources } = {}) {
  // 系统提示：最后一条 system 角色消息是"完整生效的系统提示"（in-history 语义），
  // 它进块 3；其余（含开头的）不再单独发。
  let systemText = ''
  for (const message of messages ?? []) {
    if (message?.role === 'system') {
      const text = (message.content ?? [])
        .map((block) => (block === null || typeof block !== 'object' ? '' : block.type === 'text' ? String(block.text ?? '') : ''))
        .join('')
      if (text.trim() !== '') systemText = text
    }
  }

  const out = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    if (role === 'system') continue
    const content = Array.isArray(message.content) ? message.content : []
    if (role === 'assistant') {
      const blocks = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text !== '') blocks.push({ type: 'text', text: block.text })
        } else if (block.type === 'reasoning') {
          if (typeof block.text === 'string' && block.text !== '') blocks.push({ type: 'thinking', thinking: block.text })
        } else if (block.type === 'tool-call') {
          let input = {}
          try {
            input = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : (block.arguments ?? {})
          } catch {
            input = {}
          }
          if (typeof block.id === 'string' && block.id !== '' && typeof block.name === 'string') {
            blocks.push({ type: 'tool_use', id: block.id, name: block.name, input })
          }
        }
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (role === 'tool') {
      const text = content
        .map((block) => (block === null || typeof block !== 'object' ? '' : block.type === 'text' ? String(block.text ?? '') : ''))
        .join('')
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.toolCallId ?? ''),
          content: text,
          ...(message.isError === undefined ? {} : { is_error: message.isError === true }),
        }],
      })
      continue
    }
    // user（含图片块 → base64；imageText 占位在无法内联时兜底）
    const blocks = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text !== '') blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const source = imageSources?.get(block)
        if (source !== undefined) blocks.push({ type: 'image', source })
        else if (imageText?.has(block)) blocks.push({ type: 'text', text: imageText.get(block) })
      }
    }
    if (blocks.length > 0) out.push({ role: 'user', content: blocks })
  }
  return { systemText, messages: out }
}

/** 请求体：ZCode 同款三块 system + contextPrefix + 消息/工具/推理配置。 */
export function buildRequestBody({ model, messages, system, tools, maxTokens, effort, device, imageText, imageSources }) {
  const { systemText, messages: mapped } = mapMessages(messages, { imageText, imageSources })
  const own = []
  if (typeof system === 'string' && system.trim() !== '') own.push(system)
  if (systemText.trim() !== '' && systemText !== system) own.push(systemText)

  const env = ENVIRONMENT
    .replace('{cwd}', os.homedir())
    .replace('{git}', 'no')
    .replace('{shell}', path.basename(process.env.SHELL ?? 'bash') || 'bash')
    .replace('{osVersion}', `${osPlatform()} ${osRelease()} ${osArch()}`)
    .replace('{poweredBy}', `${'account:zai-start-plan'}/${model}`)
  const dynamic = [BEFORE_ENVIRONMENT, env, AFTER_ENVIRONMENT, ...own]
  const cached = (text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } })
  const sys = [
    { type: 'text', text: BLOCK0 },
    cached(BLOCK1),
    cached('\n\n' + dynamic.join('\n\n')),
  ]

  const messagesOut = [
    { role: 'user', content: [{ type: 'text', text: CONTEXT_FIRST.replace('{date}', today()) }] },
    ...mapped,
  ]
  // cache_control 只在最后一条非 system 消息的末块（system 三块已带）
  let last = null
  for (const m of messagesOut) {
    last = m
    if (Array.isArray(m.content)) for (const x of m.content) if (x && typeof x === 'object') delete x.cache_control
  }
  if (last && typeof last.content === 'string') last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
  else if (last && Array.isArray(last.content) && last.content.length > 0) {
    const x = last.content[last.content.length - 1]
    if (x && typeof x === 'object' && !x.cache_control) x.cache_control = { type: 'ephemeral' }
  }

  const mappedTools = (tools ?? [])
    .map(toolOf)
    .filter((tool) => tool !== undefined)

  const body = {
    model,
    max_tokens: Math.min(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 128_000, 128_000),
    metadata: { user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: '' }) },
    system: sys,
    messages: messagesOut,
    stream: true,
    ...reasoningConfig(effort),
    ...(mappedTools.length > 0 ? { tools: mappedTools, tool_choice: { type: 'auto' } } : {}),
  }
  return { body }
}

/** SSE 帧解析：按空行分帧，yield {event, data}。 */
async function* sseEvents(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = function* (raw) {
    let event = 'message'
    const datas = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) datas.push(line.slice(5).trim())
    }
    if (datas.length === 0) return
    yield { event, data: datas.join('\n') }
  }
  for (;;) {
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      yield* emit(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  if (buffer.trim() !== '') yield* emit(buffer)
}

/** usage 归并（Anthropic 字段名）。 */
function updateUsage(usage, raw) {
  const o = raw !== null && typeof raw === 'object' ? raw : {}
  if (typeof o.input_tokens === 'number') usage.inputTokens = o.input_tokens
  if (typeof o.output_tokens === 'number') usage.outputTokens = o.output_tokens
  if (typeof o.cache_read_input_tokens === 'number') usage.cacheReadTokens = o.cache_read_input_tokens
  if (typeof o.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = o.cache_creation_input_tokens
}

/** 直连适配器：provider `zcode-direct` 的实现。 */
export class ZcodeDirectAdapter extends LlmAdapter {
  constructor({ options, resolveAttachments, logger }) {
    super()
    this.options = options
    this.resolveAttachments = resolveAttachments
    this.logger = logger
  }

  dispose() { /* 无常驻资源 */ }

  providerInfo(provider) {
    return { id: provider, name: 'ZCode Start Plan（直连）' }
  }

  providerRetryPolicy() {
    return this.options().retryPolicy
  }

  listModels(provider) {
    const options = this.options()
    return Promise.resolve((options.directModels ?? DIRECT_MODELS).map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: ['text', 'image'],
      contextWindow: model.context,
    })))
  }

  resolveModel(provider, model) {
    const options = this.options()
    const configured = (options.directModels ?? DIRECT_MODELS).find((entry) => entry.id === model) ??
      DIRECT_MODELS.find((entry) => entry.id === model) ?? { id: model, context: 200_000, output: 32_000, efforts: ['max'] }
    return Promise.resolve({
      provider,
      id: model,
      name: configured.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: configured.context },
      defaultMaxTokens: configured.output,
      reasoning: {
        efforts: configured.efforts.map((id) => ({ id, name: id })),
        defaultEffort: configured.efforts.includes('max') ? 'max' : configured.efforts.at(-1),
      },
    })
  }

  /** 凭证 + 设备号（登录未就绪时给出可操作的错误）。 */
  auth(dataBaseDir) {
    try {
      const auth = readZaiPlanAuth(dataBaseDir)
      return { jwt: auth.planToken, device: readOrCreateDevice(dataBaseDir) }
    } catch (error) {
      const hint = error instanceof CredentialError
        ? `${error.message}（可在本插件的设置页登录，或用 npx dsh-zcode-login）`
        : String(error?.message ?? error)
      throw new LlmError(`zcode-direct: ${hint}`, 'PROVIDER')
    }
  }

  /** 把一轮对话跑成流式迭代器（直连，无 agent）。 */
  async *stream(options) {
    const config = this.options()
    if (String(options.purpose ?? '') === 'session-title') {
      // 会话标题本地生成，不消耗额度
      const last = [...(options.messages ?? [])].reverse().find((m) => m?.role === 'user')
      const text = (Array.isArray(last?.content) ? last.content : [])
        .map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join(' ')
      const title = (text || '新会话').replace(/\s+/g, ' ').slice(0, 24)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const { jwt, device } = this.auth(config.zcodeDataBaseDir)
    const model = DIRECT_MODELS.find((entry) => entry.id === options.model) ?? DIRECT_MODELS[0]

    // 图片块 → base64 内联（attachment 服务直读；失败降级为占位文本）
    const imageText = new Map()
    const imageSources = new Map()
    const attachments = typeof this.resolveAttachments === 'function' ? this.resolveAttachments() : undefined
    for (const message of options.messages ?? []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block === null || typeof block !== 'object' || block.type !== 'image') continue
        try {
          if (block.offloaded === true) { imageText.set(block, '[图片（已归档，本轮无法内联）]'); continue }
          const file = attachments?.imageHostPath?.(block.attachment)
          const stored = file !== undefined && existsSync(file)
            ? { data: readFileSync(file) }
            : await attachments?.readImage?.(block.attachment)
          if (stored?.data === undefined) { imageText.set(block, '[图片（读取失败）]'); continue }
          const mediaType = stored.ref?.mediaType ?? 'image/png'
          imageSources.set(block, { type: 'base64', media_type: mediaType, data: Buffer.from(stored.data).toString('base64') })
        } catch (error) {
          this.logger?.warn?.(`zcode-direct: 读取图片失败（${error?.message ?? error}）`)
          imageText.set(block, '[图片（读取失败）]')
        }
      }
    }

    const { body } = buildRequestBody({
      model: model.id,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      maxTokens: options.maxTokens,
      effort: options.reasoningEffort,
      device,
      imageText,
      imageSources,
    })

    const deadline = Date.now() + (config.zcodeCliTimeoutMs ?? 900_000)
    // 重试上限：瞬时错误（429/5xx/网络断/流早断）5 次，形状/风控拒绝（405/3012）1 次
    // （后者是 IP 级风控时原地重试意义有限）。退避 1s/2s/3s/5s/8s。
    // 重试上限：瞬时错误与流中断一律 10 次尝试，指数退避 1s 起、单次封顶 48s
    // （2^n 递增：1/2/4/8/16/32/48/48…）。405/3012（形状/IP 风控）保持 2 次尝试——
    // 形状错误重试不会变好，IP 风控短窗口内原地重试意义有限。
    const MAX_ATTEMPTS = 10
    const BLOCKED_ATTEMPTS = 2
    const retryDelay = (attempt) => Math.min(2 ** (attempt - 1), 48) * 1000
    const blockedRe = /unusual activity|"code"\s*:\s*"?3012\b/i
    const isBlocked = (status, text) => status === 405 || blockedRe.test(text)
    const isTransientStatus = (status) => [408, 429, 500, 502, 503, 504].includes(status)
    // "terminated"/ECONNRESET 等：连接被远端掐断。长命令执行期间连接空闲被服务端
    // 关闭、下一轮复用僵死连接时最常见（undici 对非幂等请求不自动重试）。
    const isDropped = (error) => /terminated|aborted|reset|ECONNRESET|EPIPE|socket|network/i.test(String(error?.message ?? error) + String(error?.cause?.message ?? error?.cause?.code ?? ''))

    let attempt = 0
    let emitted = false // 已吐出内容的标记（仅供日志；中断后仍重试，新块编号接续）
    let blockBase = 0   // 跨重试已发出的块数（新尝试的块索引接续，避免 DSH 侧索引重复）
    for (;;) {
      attempt += 1
      const blocks = new Map()
      const usage = { inputTokens: 0, outputTokens: 0 }
      // 重试前收口：给上一轮未闭合的块补发 block-end（协议要求 message_stop 时全部闭合）
      const closeOpen = function* () {
        for (const block of blocks.values()) {
          if (block.closed) continue
          block.closed = true
          if (block.content.type === 'tool-call' && block.json.length > 0) block.content.arguments = block.json
          yield { type: 'block-end', index: block.index, block: { ...block.content } }
        }
      }
      let response
      try {
        response = await fetch(`${START_BASE}/v1/messages`, {
          method: 'POST',
          headers: startHeaders(jwt),
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw new LlmError('请求被调用方中止', 'ABORTED')
        yield* closeOpen()
        blockBase += blocks.size
        if (attempt < MAX_ATTEMPTS && isDropped(error)) {
          const delay = retryDelay(attempt)
          this.logger?.warn?.(`zcode-direct: 连接中断（${String(error?.message ?? error).slice(0, 120)}），${delay}ms 后换连接重试（第 ${attempt} 次）`)
          await sleep(delay).catch(() => {})
          if (options.signal?.aborted) throw new LlmError('请求被调用方中止', 'ABORTED')
          continue
        }
        throw new LlmError(`zcode-direct: 请求失败（${error?.message ?? error}）`, 'TRANSPORT')
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const message = text.slice(0, 300) || `${response.status} ${response.statusText}`
        if (response.status === 401) {
          throw new LlmError('ZCode Start Plan 凭证被拒（401）：登录已过期，请到本插件设置页重新登录。', 'PROVIDER')
        }
        const blocked = isBlocked(response.status, text)
        const transient = isTransientStatus(response.status)
        if (!blocked && !transient) {
          this.logger?.warn?.(`zcode-direct: 端点拒绝（HTTP ${response.status}）${message}`)
          throw new LlmError(`ZCode Start Plan 请求失败（HTTP ${response.status}）：${message}`, 'PROVIDER')
        }
        if (attempt >= (blocked ? BLOCKED_ATTEMPTS : MAX_ATTEMPTS)) {
          if (blocked) {
            this.logger?.warn?.(`zcode-direct: 重试仍被拒（HTTP ${response.status}）${message}（model=${body.model} effort=${body.output_config?.effort ?? 'off'} system块=${body.system.map((b) => b.text.length).join('/')} 消息=${body.messages.length} 工具=${body.tools?.length ?? 0}）`)
            throw new LlmError(`ZCode Start Plan 端点拒绝：${message} — ${BLOCKED_HINT}`, 'PROVIDER')
          }
          throw new LlmError(`ZCode Start Plan 网关暂不可用（HTTP ${response.status}），已重试 ${attempt - 1} 次：${message}`, 'PROVIDER')
        }
        const delay = blocked ? 2000 : retryDelay(attempt)
        this.logger?.warn?.(
          `zcode-direct: HTTP ${response.status}（${blocked ? '形状/风控拒绝' : '网关瞬断'}），${delay}ms 后换请求 id 重试（第 ${attempt} 次）`,
        )
        yield* closeOpen()
        blockBase += blocks.size
        await sleep(delay).catch(() => {})
        if (options.signal?.aborted) throw new LlmError('请求被调用方中止', 'ABORTED')
        continue
      }

      // SSE → Harness 流协议；流开始前的中断（连接被掐等）可安全重试
      try {
        let started = false
        let reason
        for await (const event of sseEvents(response)) {
          if (options.signal?.aborted) throw new LlmError('请求被调用方中止', 'ABORTED')
          if (Date.now() > deadline) throw new LlmError('zcode-direct: 回合超时', 'TIMEOUT')
          let data
          try {
            data = JSON.parse(event.data)
          } catch {
            continue
          }
          if (event.event === 'error' || data.type === 'error') {
            const detail = data.error?.message ?? data.message ?? JSON.stringify(data).slice(0, 200)
            throw new LlmError(`ZCode Start Plan 回合失败：${detail}`, 'PROVIDER')
          }
          if (data.type === 'message_start') {
            if (started) throw new LlmError('zcode-direct: 重复 message_start', 'PROVIDER')
            updateUsage(usage, data.message?.usage)
            started = true
            continue
          }
          if (!['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping'].includes(String(data.type))) continue
          if (!started) continue
          const wireIndex = data.index
          if (data.type === 'content_block_start') {
            const native = data.content_block ?? {}
            let content
            let replay = { type: 'text' }
            if (native.type === 'thinking') content = { type: 'reasoning', text: String(native.thinking ?? '') }
            else if (native.type === 'tool_use') {
              content = { type: 'tool-call', id: String(native.id ?? ''), name: String(native.name ?? ''), arguments: JSON.stringify(native.input ?? {}) }
              replay = { type: 'tool-call' }
            } else content = { type: 'text', text: String(native.text ?? '') }
            const index = blockBase + blocks.size
            blocks.set(wireIndex, { index, content, replay, closed: false, json: '' })
            emitted = true
            yield { type: 'block-start', index, blockType: content.type }
            if (content.type === 'text' || content.type === 'reasoning') {
              if (content.text !== '') yield { type: content.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: content.text }
            } else {
              yield { type: 'tool-call-delta', index, id: content.id, name: content.name, argumentsDelta: '' }
            }
          } else if (data.type === 'content_block_delta') {
            const block = blocks.get(data.index)
            if (block === undefined || block.closed) continue
            const delta = data.delta ?? {}
            if (delta.type === 'text_delta' && block.content.type === 'text') {
              const text = String(delta.text ?? '')
              block.content.text += text
              yield { type: 'text-delta', index: block.index, text }
            } else if (delta.type === 'thinking_delta' && block.content.type === 'reasoning') {
              const text = String(delta.thinking ?? '')
              block.content.text += text
              yield { type: 'reasoning-delta', index: block.index, text }
            } else if (delta.type === 'signature_delta' && block.content.type === 'reasoning') {
              block.replay.signature = String(delta.signature ?? '')
            } else if (delta.type === 'input_json_delta' && block.content.type === 'tool-call') {
              const argumentsDelta = String(delta.partial_json ?? '')
              block.json += argumentsDelta
              yield { type: 'tool-call-delta', index: block.index, id: block.content.id, argumentsDelta }
            }
          } else if (data.type === 'content_block_stop') {
            const block = blocks.get(data.index)
            if (block === undefined || block.closed) continue
            block.closed = true
            if (block.content.type === 'tool-call' && block.json.length > 0) block.content.arguments = block.json
            yield { type: 'block-end', index: block.index, block: { ...block.content } }
          } else if (data.type === 'message_delta') {
            const stop = data.delta?.stop_reason
            if (stop === 'end_turn' || stop === 'stop_sequence') reason = { kind: 'stop' }
            else if (stop === 'tool_use') reason = { kind: 'tool-calls' }
            else if (stop === 'max_tokens') reason = { kind: 'max-tokens' }
            if (data.usage !== undefined) updateUsage(usage, data.usage)
          } else if (data.type === 'message_stop') {
            if (reason === undefined) reason = { kind: 'stop' }
            usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            yield { type: 'usage', usage }
            yield {
              type: 'finish',
              reason,
              replayState: {
                response: { model: options.model, stopReason: 'end_turn' },
                blocks: [...blocks.values()].map((block) => block.replay),
              },
            }
            return
          }
        }
        throw new LlmError('zcode-direct: 流在 message_stop 前结束', 'STREAM_CLOSED')
      } catch (error) {
        if (options.signal?.aborted) throw new LlmError('请求被调用方中止', 'ABORTED')
        if (error instanceof LlmError && error.code === 'PROVIDER') throw error // 上游业务错误（额度/鉴权等），不重试
        if (error instanceof LlmError && error.code === 'TIMEOUT') throw error
        yield* closeOpen()
        blockBase += blocks.size
        const dropped = isDropped(error)
        if (attempt < MAX_ATTEMPTS && (dropped || error?.code === 'STREAM_CLOSED' || isTransientStatus(Number(error?.status)))) {
          const delay = retryDelay(attempt)
          this.logger?.warn?.(`zcode-direct: 流在出内容前中断（${String(error?.message ?? error).slice(0, 120)}），${delay}ms 后换连接重试（第 ${attempt} 次）`)
          await sleep(delay).catch(() => {})
          if (options.signal?.aborted) throw new LlmError('请求被调用方中止', 'ABORTED')
          continue
        }
        const hint = emitted ? '（本轮已输出部分内容）' : (dropped ? '（连接被远端中断，通常是网关关闭了空闲连接）' : '')
        throw new LlmError(`zcode-direct: 流中断 ${hint}：${String(error?.message ?? error).slice(0, 200)}`, 'TRANSPORT')
      }
    }
  }
}
