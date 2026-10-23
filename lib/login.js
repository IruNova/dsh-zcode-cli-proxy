/**
 * Z.AI 登录引擎：与 zcode.cjs `login zai` 同款协议（2026-10 逆向自 0.17.0 bundle），全部实测。
 *
 * 流程（轮询型 device 授权 —— 回调落在 zcode.z.ai 服务端，**任何设备的浏览器打开链接都行**，
 * 不要求浏览器与插件同机）：
 *   1. 客户端生成 pollToken（32 字节随机 hex）；
 *   2. POST {base}/oauth/cli/init，Authorization: Bearer <pollToken>，body {provider:'zai'}
 *      → {flow_id, authorize_url, expires_at（epoch 秒）, poll_interval_sec（≥1）}；
 *   3. 用户在 authorize_url 上完成 Z.AI 授权（服务端回调把 code 绑到该 flow）；
 *   4. 轮询 GET {base}/oauth/cli/poll/{flow_id}，Bearer pollToken
 *      → {status:'pending'|'failed'|'ready'}；ready 附 {token（zcodejwttoken）, user, accessToken, refreshToken?}；
 *   5. 凭证写入 ~/.zcode/v2/credentials.json（enc:v1 AES-256-GCM，机器指纹密钥）：
 *      oauth:active_provider / oauth:zai:access_token / zcodejwttoken / oauth:zai:user_info。
 *
 * @module lib/login.js
 */

import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { writeCredentialKeys, readZaiPlanAuth, CredentialError } from './credentials.js'

const LOGIN_BASE = 'https://zcode.z.ai/api/v1'
const LOGIN_USER_AGENT = `ZCode/${'0.17.0'}`
/** 单次登录的默认上限（毫秒）；上游 CLI 用 init 响应的 expires_at 与此取小。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000

/** @typedef {{stage:'url', url:string} | {stage:'waiting'} | {stage:'writing'} | {stage:'done', user?:object} | {stage:'cancelled'} | {stage:'error', message:string}} LoginStatus */

/**
 * 跑一轮 Z.AI 登录。每步经 onStatus 汇报；signal 中止则抛 AbortError。
 * @param {object} opts
 * @param {string} [opts.dataBaseDir] 凭证目录（~/.zcode 的上层；空 = 用户主目录）
 * @param {(status: LoginStatus) => void} [opts.onStatus]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ user?: object }>}
 */
export async function runZaiLogin({ dataBaseDir, onStatus, signal, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const report = (status) => {
    try {
      onStatus?.(status)
    } catch {
      /* 状态回调不影响登录 */
    }
  }
  if (signal?.aborted) throw new Error('登录已取消')
  const pollToken = randomBytes(32).toString('hex')

  // 1) init
  const providerId = 'zai'
  const init = await postJson(`${LOGIN_BASE}/oauth/cli/init`, { provider: providerId }, pollToken, signal)
  const flowId = requireString(init?.flow_id, 'init 响应缺 flow_id')
  const authorizeUrl = requireString(init?.authorize_url, 'init 响应缺 authorize_url')
  if (!URL.canParse(authorizeUrl) || new URL(authorizeUrl).protocol !== 'https:') {
    throw new Error('init 响应的 authorize_url 不是 https 链接')
  }
  const expiresAtMs = typeof init?.expires_at === 'number' && Number.isFinite(init.expires_at)
    ? init.expires_at * 1000 : Date.now() + timeoutMs
  const intervalMs = Math.max(1000, typeof init?.poll_interval_sec === 'number' ? init.poll_interval_sec * 1000 : 1500)
  report({ stage: 'url', url: authorizeUrl })

  // 2) 轮询（上游 pollUntilReady：4xx 非 408/429/5xx 视为致命）
  const deadline = Math.min(Date.now() + timeoutMs, expiresAtMs)
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('登录已取消')
    let poll
    try {
      poll = await getJson(`${LOGIN_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`, pollToken, signal)
    } catch (error) {
      const status = error?.httpStatus
      if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500)) {
        await sleep(intervalMs, undefined, { signal }).catch(() => { throw new Error('登录已取消') })
        continue
      }
      throw error
    }
    const state = poll?.status
    if (state === 'ready') {
      // ready 响应与 CLI 的 una() 解析一致：token / user 在顶层，access_token / refresh_token
      // 藏在按 providerId 分组的子对象里（{..., zai:{access_token, refresh_token}}）
      const token = requireString(poll?.token, 'ready 响应缺 token（zcodejwttoken）')
      const providerBlock = (poll?.zai !== null && typeof poll?.zai === 'object') ? poll.zai
        : (poll?.[providerId] !== null && typeof poll?.[providerId] === 'object') ? poll[providerId] : undefined
      const accessToken = requireString(
        providerBlock?.access_token ?? providerBlock?.accessToken ?? poll?.accessToken ?? poll?.access_token,
        `ready 响应缺 access_token（顶层键：${Object.keys(poll ?? {}).join(', ') || '∅'}）`,
      )
      const user = (poll?.user !== null && typeof poll?.user === 'object') ? poll.user : {}
      if (typeof user.user_id !== 'string' || user.user_id === '') throw new Error('ready 响应缺 user.user_id')
      report({ stage: 'writing' })
      // 与 zcode.cjs saveZaiLoginCredentials 一致的键集（zai 不落 refreshToken）
      writeCredentialKeys(dataBaseDir, {
        'oauth:active_provider': 'zai',
        'oauth:zai:access_token': accessToken,
        zcodejwttoken: token,
        'oauth:zai:user_info': JSON.stringify(user),
      })
      report({ stage: 'done', user })
      return { user }
    }
    if (state === 'failed') throw new Error(poll?.error_description ?? poll?.error ?? '上游返回授权失败（failed）')
    // pending → 继续等
    await sleep(intervalMs, undefined, { signal }).catch(() => { throw new Error('登录已取消') })
  }
  throw new Error('授权超时（等待确认超过时限），请重新发起登录')
}

/** 退出登录：清掉 zai 家族的共享凭证键（与 CLI logout 同效）。 */
export function logoutZai(dataBaseDir) {
  writeCredentialKeys(dataBaseDir, {}, [
    'oauth:active_provider',
    'oauth:zai:access_token',
    'oauth:zai:refresh_token',
    'oauth:zai:user_info',
    'zcodejwttoken',
  ])
}

/** 当前是否已有可用凭证（用于面板显示登录态）。 */
export function hasPlanCredentials(dataBaseDir) {
  try {
    readZaiPlanAuth(dataBaseDir)
    return true
  } catch (error) {
    if (error instanceof CredentialError) return false
    return false
  }
}

async function postJson(url, body, token, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': LOGIN_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal,
  })
  return parseResponse(response, 'POST')
}

async function getJson(url, token, signal) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'user-agent': LOGIN_USER_AGENT },
    signal,
  })
  return parseResponse(response, 'GET')
}

async function parseResponse(response, method) {
  let body
  try {
    body = await response.json()
  } catch {
    /* 非 JSON 响应体 */
  }
  if (!response.ok) {
    const detail = body?.msg ?? body?.error_description ?? body?.error ?? ''
    const error = new Error(`上游 ${method} 失败（HTTP ${response.status}${detail === '' ? '' : `：${detail}`}）`)
    error.httpStatus = response.status
    throw error
  }
  // 响应信封：{code, msg, data}（与 CLI 的 HTTP 层解包一致）；code ≠ 0 视为业务失败
  if (body !== null && typeof body === 'object' && 'code' in body && 'data' in body) {
    if (body.code !== 0) {
      const error = new Error(`上游 ${method} 失败（code=${body.code}${body.msg ? `：${body.msg}` : ''}）`)
      error.httpStatus = response.status
      throw error
    }
    return body.data
  }
  return body
}

function requireString(value, message) {
  if (typeof value !== 'string' || value === '') throw new Error(message)
  return value
}
