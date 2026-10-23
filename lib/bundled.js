/**
 * 插件内置（vendored）的 ZCode agent 运行时。
 *
 * `vendor/zcode/` 里带着一份从 ZCode 桌面客户端拷出的 `zcode.cjs`（agent 运行时）
 * 与 `zcode-builtin.json`（builtin provider 配置种子），让本插件不再依赖本机安装
 * ZCode 客户端：
 *   - `zcode.cjs`：app-server 通道的宿主进程，plain node 即可运行（实测 0.17.0）；
 *   - `zcode-builtin.json`：Start Plan 注入的 configSource / basedOn 依据 ——
 *     未安装客户端的机器上 ~/.zcode/v2/runtime/provider/ 不存在，用这份种子顶上
 *     （路径与 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向同一文件，revision 哈希自洽）；
 *   - `manifest.json`：来源与版本信息（cliVersion 用作 ZCODE_APP_VERSION / UA 指纹）。
 *
 * 客户端 `resources/glm/packages/` 下的官方插件（browser-use、node-repl-host 等）
 * 有 100MB+，不随插件内置：缺失时对应工具优雅降级，app-server 基础链路不受影响。
 *
 * 更新内置运行时：`node scripts/sync-vendor.mjs`（从本机已装的客户端重新拷贝）。
 *
 * @module lib/bundled.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

export const BUNDLED_DIR = path.join(PLUGIN_DIR, 'vendor', 'zcode')
export const BUNDLED_CLI_PATH = path.join(BUNDLED_DIR, 'zcode.cjs')
export const BUNDLED_BUILTIN_PATH = path.join(BUNDLED_DIR, 'zcode-builtin.json')
export const BUNDLED_MANIFEST_PATH = path.join(BUNDLED_DIR, 'manifest.json')

/** 读取内置运行时的 manifest（缺失 / 损坏时返回 undefined，不致命）。 */
export function bundledManifest() {
  try {
    return JSON.parse(fs.readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
  } catch {
    return undefined
  }
}

/** 内置 zcode.cjs 是否可用（存在且非空）。 */
export function bundledCliAvailable() {
  try {
    return fs.statSync(BUNDLED_CLI_PATH).size > 0
  } catch {
    return false
  }
}
