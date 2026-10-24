/**
 * dsh-zcode cli反代 — 把 DSH 的模型请求转交给 ZCode 客户端自带的 agent（zcode.cjs）执行。
 *
 * 本插件只保留一条通道：provider `zcode-cli` 走 GUI 同款的常驻 app-server 会话
 * （JSON-RPC over stdio，真流式）——插件把 ZCode Start Plan 账户注入 agent 并在每次
 * 请求前提供 OAuth 鉴权，模型请求直接烧 Start Plan / Coding Plan 额度。
 * 通道的实现与协议细节见 lib/app-server.js 的头部注释。
 *
 * 历史说明：本插件最初是 zcode2api（HTTP 网关 + 账号池）的 DSH 集成；2026-09-30 起
 * 网关与一次性 CLI 通道已移除 —— 需要它们的请使用原版 https://github.com/liu5269/zcode2api。
 *
 * 依赖只有 harness 自带的 peer 包，没有第三方运行时依赖。
 * ZCode agent 运行时（zcode.cjs + builtin 配置种子）已内置在 vendor/zcode/，
 * 本机不装 ZCode 客户端也能跑（见 lib/bundled.js）。
 *
 * @module dsh-zcode-cli-proxy
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { ZcodeAppServerAdapter } from './app-server.js'
import { ZcodeDirectAdapter, DIRECT_MODELS } from './direct.js'
import { BUNDLED_CLI_PATH, bundledCliAvailable } from './bundled.js'
import { runZaiLogin, logoutZai, hasPlanCredentials } from './login.js'

export const name = 'dsh-zcode-cli-proxy'

/** `llm` 承载模型提供方注册。 */
export const inject = ['llm']

/** 插件包目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/** 登录面板的动作取值（volatile 字段 login 的合法值）。 */
const LOGIN_ACTIONS = ['idle', 'start', 'cancel', 'logout']
const LOGIN_ACTIONS_SCHEMA = z.union(LOGIN_ACTIONS)

// ── 配置 ──────────────────────────────────────────────────────────────────────

const MODEL_MODALITIES = ['text', 'image']
const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_CONTEXT_WINDOW = 200000

/**
 * ZCode 客户端自带的 CLI（zcode.cjs）候选路径。
 *
 * 为什么需要它：计划端点（zcode.z.ai/.../zcode-plan/anthropic）带阿里云无痕验证，
 * 外部 HTTP 调用（包括真实浏览器、客户端 renderer）都会被服务端判 3007/3012 拦掉；
 * 而客户端自带的这个 CLI 用的是它自己的凭证与验证码链路 —— app-server 模式实测可用。
 *
 * 本插件在 vendor/zcode/ 内置了一份从客户端拷出的 zcode.cjs（见 lib/bundled.js）：
 * 自动探测（下表）都落空、且 allowBundledRuntime 未关闭时回落到内置副本，
 * 本机不再需要安装 ZCode 客户端。
 */
const ZCODE_CLI_CANDIDATES = [
  process.env.ZCODE_CLI_PATH,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
    : undefined,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs') : undefined,
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  '/opt/ZCode/resources/glm/zcode.cjs',
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

/** provider `zcode-cli` 对外暴露的模型清单（Start Plan 的 GLM 系列，支持视觉输入）。
 * 上下文 / maxTokens 默认值来自客户端 builtin 配置的生效值（GLM-5.3 系 1M / 128k）；
 * 推理档位见 lib/app-server.js 的实测表，可在条目上用 reasoningLevels / reasoningLevel 覆盖。 */
const DEFAULT_CLI_MODELS = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3 (ZCode)',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    startPlanModelId: 'GLM-5.3',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash (ZCode)',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    startPlanModelId: 'GLM-5.3-Flash',
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2 (ZCode)',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    startPlanModelId: 'GLM-5.2',
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo (ZCode)',
    contextWindow: 200000,
    maxTokens: 64000,
    inputModalities: ['text', 'image'],
    startPlanModelId: 'GLM-5-Turbo',
  },
]

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text', 'image']),
  startPlanModelId: z.string()
    .description('该条目映射到的 Start Plan 执行模型（GLM-5.3 / GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo）；缺省 = 条目 id 原样'),
  reasoningLevel: z.string()
    .description('默认推理档位（DSH 侧未选择档位时用）；缺省 = 档位表里的 max（无 max 时取最高档）'),
  reasoningLevels: z.array(z.string())
    .description('可选推理档位（低 → 高），暴露到 DSH 模型选择器；缺省 = 实测表（GLM-5.3/Flash: low/high/max，GLM-5.2: disabled/high/max，GLM-5-Turbo: disabled/enabled）'),
})

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关掉后不注册模型提供方'),
  zcodeCliPath: z.string().default('')
    .description('ZCode 客户端自带的 zcode.cjs 路径；留空 = 依次自动探测本机安装的客户端、插件内置副本（vendor/zcode/zcode.cjs）'),
  zcodeCliNode: z.string().default('node').description('运行 zcode.cjs 的 node 可执行文件；本机没有 node 时自动回落到宿主运行时（Electron 以 ELECTRON_RUN_AS_NODE 模式运行）'),
  allowBundledRuntime: z.boolean().default(true)
    .description('允许使用插件内置的 ZCode 运行时（vendor/zcode/）：本机没装 ZCode 客户端 / 没探测到 CLI 时用它，不再依赖本机安装'),
  zcodeCliTimeoutMs: z.number().step(1).min(5000).default(900000).description('app-server 单回合（session/send → turn 完成）的超时（毫秒）'),
  cliModels: z.array(catalogModel).default(DEFAULT_CLI_MODELS)
    .description('provider `zcode-cli` 暴露给 DSH 的模型清单；实际执行模型由 Start Plan 注入决定'),
  cliCwd: z.string().default('').description('app-server 会话的工作目录；留空 = 用户主目录'),
  injectStartPlanAccount: z.boolean().default(true)
    .description('把 Start Plan 账户注入 agent（GUI 同款）。关闭则用 agent 冷启动的默认供应商'),
  zcodeDataBaseDir: z.string().default('')
    .description('ZCode 共享凭证目录（读 Start Plan OAuth token）；留空 = 用户主目录（~/.zcode/v2/credentials.json）'),
  childEnvAllow: z.array(z.string()).default([])
    .description('额外透传给 app-server 子进程的环境变量名；默认只透传系统基础变量、ZCODE_* 与 NODE_EXTRA_CA_CERTS'),
  bridgePrompts: z.boolean().default(false)
    .description('（agent 通道）在首轮注入「宿主工具桥接说明」。默认关闭 = 不加任何额外提示词；若出现模型把 DSH 工具写成正文、工具不可用的情况再打开'),
  directEnabled: z.boolean().default(true)
    .description('启用直连 provider `zcode-direct`：不经 agent，DSH 的系统提示/工具/权限原生生效（真·正常 API 体验）。与 agent 通道可同时启用，模型列表里二选一'),
  appServerTimeoutMs: z.number().step(1).min(5000).default(120000)
    .description('app-server 单次请求（create/subscribe/send）的超时（毫秒）'),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).description('默认 max_tokens'),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).description('默认上下文窗口'),
  retryPolicy: RetryPolicySchema,
  // ── 登录面板（volatile 字段：只出现在设置表单里，不随普通配置持久化/重启插件） ──
  login: LOGIN_ACTIONS_SCHEMA.volatile().default('idle')
    .description('登录面板：选「start」保存即可发起登录（任意设备的浏览器打开授权链接完成确认）；cancel = 取消；logout = 退出登录'),
  loginState: z.string().volatile().default('')
    .description('登录状态（由插件写入，无需手动修改）'),
  loginUrl: z.string().volatile().default('')
    .description('授权链接（发起登录后出现；任何设备的浏览器打开皆可）'),
})

/** 校验并规范化模型清单（与 dsh-llm-anthropic 保持一致的校验强度）。 */
function resolveModels(models) {
  const seen = new Set()
  return (models ?? DEFAULT_CLI_MODELS).map((model) => {
    if (typeof model.id !== 'string' || model.id.length === 0) throw new Error('zcode: 模型 id 不能为空')
    if (model.name !== undefined && model.name.length === 0) throw new Error(`zcode: 模型 "${model.id}" 的 name 不能为空`)
    if (seen.has(model.id)) throw new Error(`zcode: 模型 "${model.id}" 重复`)
    seen.add(model.id)
    const inputModalities = model.inputModalities ?? ['text', 'image']
    if (inputModalities.length === 0) throw new Error(`zcode: 模型 "${model.id}" 的 inputModalities 不能为空`)
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: [...inputModalities],
      ...(model.startPlanModelId === undefined || model.startPlanModelId === ''
        ? {} : { startPlanModelId: model.startPlanModelId }),
      ...(model.reasoningLevel === undefined || model.reasoningLevel === ''
        ? {} : { reasoningLevel: model.reasoningLevel }),
      ...(Array.isArray(model.reasoningLevels) ? { reasoningLevels: [...model.reasoningLevels] } : {}),
    }
  })
}

/** 把 Config 解析成一份运行期只读配置；非法值直接抛错。 */
export function resolveOptions(config) {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('zcode: defaultContextWindow 必须是正整数')
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('zcode: maxTokens 必须是正整数')
  }
  const zcodeCliTimeoutMs = config.zcodeCliTimeoutMs ?? 900000
  if (!Number.isSafeInteger(zcodeCliTimeoutMs) || zcodeCliTimeoutMs < 5000) {
    throw new Error('zcode: zcodeCliTimeoutMs 必须是不小于 5000 的整数')
  }

  return {
    enabled: config.enabled !== false,
    zcodeCliPath: (() => {
      const configured = (config.zcodeCliPath ?? '').trim()
      if (configured !== '') return configured
      const installed = ZCODE_CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate))
      if (installed !== undefined) return installed
      // 本机没装（或没探测到）客户端：回落到插件内置的运行时，实现脱安装运行
      return config.allowBundledRuntime !== false && bundledCliAvailable() ? BUNDLED_CLI_PATH : ''
    })(),
    zcodeCliNode: (config.zcodeCliNode ?? 'node').trim() || 'node',
    allowBundledRuntime: config.allowBundledRuntime !== false,
    zcodeCliTimeoutMs,
    cliModels: resolveModels(config.cliModels),
    cliCwd: (config.cliCwd ?? '').trim(),
    bridgePrompts: config.bridgePrompts === true,
    directEnabled: config.directEnabled !== false,
    directModels: DIRECT_MODELS,
    injectStartPlanAccount: config.injectStartPlanAccount !== false,
    zcodeDataBaseDir: (config.zcodeDataBaseDir ?? '').trim(),
    childEnvAllow: Array.isArray(config.childEnvAllow)
      ? config.childEnvAllow.filter((key) => typeof key === 'string' && key.trim() !== '')
      : [],
    appServerTimeoutMs: config.appServerTimeoutMs ?? 120000,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'zcode: retryPolicy'),
  }
}

// ── apply ─────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  // 配置热更新：一次非法改动不应打挂正在跑的插件，保留上一份可用配置。
  let current = () => config
  let lastRaw
  let lastGood
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('zcode: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  const adapter = new ZcodeAppServerAdapter({
    options,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })
  const directAdapter = new ZcodeDirectAdapter({
    options,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })

  // ── 模型提供方 ──────────────────────────────────────────────────────────────
  const entryNs = ctx.fiber?.entry?.options?.id ?? name

  ctx.effect(() => () => {
    if (typeof adapter.dispose === 'function') adapter.dispose()
    if (typeof directAdapter.dispose === 'function') directAdapter.dispose()
  }, 'zcode-cli: app-server client')

  // ── 登录面板 ────────────────────────────────────────────────────────────────
  // volatile 字段是宿主设置表单与插件之间的实时通道：表单里选动作保存 → loader 把新值
  // 提交进运行中的引用（不重启插件）→ 这里轮询到动作并执行，进度经 settings.write 写回
  // （宿主广播 settings/document-updated，网页端表单自动刷新）。
  let loginAbort = undefined

  /** volatile 字段取值：老版本 schemastery / 测试桩可能是普通值而非引用。 */
  const unwrap = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
  const readAction = () => {
    const action = unwrap(config.login)
    return LOGIN_ACTIONS.includes(action) ? action : 'idle'
  }

  const writeLogin = async (fields) => {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    const payload = { ...fields }
    try {
      if (settings === undefined || typeof settings.write !== 'function') throw new Error('settings 服务不可用')
      await settings.write(entryNs, (current) => ({ ...current, login: 'idle', ...payload }))
    } catch (error) {
      logger.warn?.(`zcode: 登录面板写入失败（${error?.message ?? error}）`)
      if (payload.loginUrl !== undefined) logger.info?.(`zcode: 授权链接：${payload.loginUrl}`)
      if (payload.loginState !== undefined) logger.info?.(`zcode: 登录状态：${payload.loginState}`)
    }
  }

  const startLogin = async () => {
    if (loginAbort !== undefined) {
      await writeLogin({ loginState: '⏳ 已有登录在进行中：请打开下方授权链接完成确认，或先选 cancel 取消。' })
      return
    }
    const controller = new AbortController()
    loginAbort = controller
    const describe = (user) => (user?.email ?? user?.name ?? user?.user_id ?? '已登录')
    try {
      await runZaiLogin({
        dataBaseDir: options().zcodeDataBaseDir,
        signal: controller.signal,
        onStatus: (status) => {
          if (status.stage === 'url') {
            void writeLogin({
              loginState: '⏳ 已发起登录：请在任意设备的浏览器打开下方「授权链接」完成确认（约 10 分钟内有效）。',
              loginUrl: status.url,
            })
          } else if (status.stage === 'writing') {
            void writeLogin({ loginState: '⏳ 已授权，正在写入凭证…' })
          } else if (status.stage === 'done') {
            void writeLogin({ loginState: `✅ 登录成功（${describe(status.user)}）。模型请求将直接使用该账号的 Start Plan 额度。` })
          }
        },
      })
      logger.info?.('zcode: 登录成功')
    } catch (error) {
      const detail = String(error?.message ?? error)
      if (controller.signal.aborted) {
        await writeLogin({ loginState: '已取消登录。' })
        logger.info?.('zcode: 登录已取消')
      } else {
        await writeLogin({ loginState: `❌ 登录失败：${detail}（可重选 start 重试）` })
        logger.warn?.(`zcode: 登录失败：${detail}`)
      }
    } finally {
      loginAbort = undefined
      // 动作是一次性触发沿：消费完复位，便于下次重新选择
      if (readAction() !== 'idle') await writeLogin({})
    }
  }

  const handleAction = (action) => {
    if (action === 'start') {
      void startLogin()
    } else if (action === 'cancel') {
      try {
        loginAbort?.abort()
      } catch {
        /* 已经结束 */
      }
      if (loginAbort === undefined) void writeLogin({ loginState: '当前没有进行中的登录。' })
    } else if (action === 'logout') {
      try {
        logoutZai(options().zcodeDataBaseDir)
        void writeLogin({ loginState: '已退出登录（共享凭证中的 Z.AI 登录已清除）。' })
        logger.info?.('zcode: 已退出登录（清除共享凭证）')
      } catch (error) {
        void writeLogin({ loginState: `❌ 退出登录失败：${error?.message ?? error}` })
      }
    }
  }

  // 轮询动作引用（volatile 更新不打断插件，轮询是最稳的感知方式）；持久化里残留的
  // 'start'（上次会话遗留）视为过期动作，只复位不执行。
  let lastAction = readAction()
  if (lastAction !== 'idle') {
    lastAction = 'idle'
    void writeLogin({})
  }
  const loginTimer = setInterval(() => {
    const action = readAction()
    if (action === lastAction) return
    lastAction = action
    handleAction(action)
  }, 1000)
  loginTimer.unref?.()

  ctx.effect(() => () => {
    clearInterval(loginTimer)
    try {
      loginAbort?.abort()
    } catch {
      /* 已经结束 */
    }
    loginAbort = undefined
  }, 'zcode-cli: login panel')

  if (options().enabled && options().directEnabled) {
    ctx.llm.registerConfigurableProviders([{
      provider: 'zcode-direct',
      displayName: 'ZCode Start Plan（直连）',
      settingsNs: entryNs,
      settingsPath: [],
    }])
    ctx.llm.registerAdapter(['zcode-direct'], directAdapter)
    logger.info?.(`zcode: provider "zcode-direct" 已注册（直连通道），模型=${(options().directModels ?? []).map((model) => model.id).join('/')}`)
  }

  if (options().enabled) {
    if (options().zcodeCliPath !== '') {
      ctx.llm.registerConfigurableProviders([{
        provider: 'zcode-cli',
        displayName: 'ZCode Start Plan（客户端反代）',
        settingsNs: entryNs,
        settingsPath: [],
      }])
      ctx.llm.registerAdapter(['zcode-cli'], adapter)
      logger.info?.(`zcode: provider "zcode-cli" 已注册（app-server Start Plan 通道），模型=${options().cliModels.map((model) => model.id).join('/')}`)
    } else {
      logger.warn?.('zcode: 没探测到 ZCode CLI（本机未装客户端且内置运行时不可用），provider "zcode-cli" 未注册（可用配置项 zcodeCliPath 指定，或恢复 vendor/zcode/ 内置副本）')
    }
  }

  logger.info?.(`zcode: 已加载，provider="zcode-cli"（Start Plan 反代），模型=${options().cliModels.map((model) => model.id).join('/')}`)
}

export { ZcodeAppServerAdapter }
export default { name, inject, Config, apply }
