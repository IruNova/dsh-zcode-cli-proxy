/**
 * 从本机已装的 ZCode 客户端把 zcode.cjs / zcode-builtin.json 同步进插件的
 * vendor/zcode/ 内置运行时（更新版本时用）。
 *
 *   node scripts/sync-vendor.mjs [客户端glm目录]
 *
 * 不带参数时按与 lib/index.js 相同的候选表自动探测客户端安装位置。
 * 同步完重算 manifest.json 里的 sha256 与版本号。
 *
 * @module scripts/sync-vendor.mjs
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VENDOR = path.join(ROOT, 'vendor', 'zcode')

/** 与 lib/index.js 的 ZCODE_CLI_CANDIDATES 保持一致的客户端探测表。 */
function candidateGlmDirs() {
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm') : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ZCode', 'resources', 'glm') : undefined,
    '/Applications/ZCode.app/Contents/Resources/glm',
    '/opt/ZCode/resources/glm',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
}

/** 从已装的客户端找最新的 zcode-builtin.json（GUI 同款运行时目录）。 */
function findInstalledBuiltin() {
  const machine = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  const root = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider', `${process.platform}-${machine}`)
  let best
  try {
    for (const versionDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) continue
      for (const endpointDir of fs.readdirSync(path.join(root, versionDir.name), { withFileTypes: true })) {
        if (!endpointDir.isDirectory() || !endpointDir.name.startsWith('endpoint-')) continue
        const full = path.join(root, versionDir.name, endpointDir.name, 'zcode-builtin.json')
        try {
          const stat = fs.statSync(full)
          if (best === undefined || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs }
        } catch { /* 下一个 */ }
      }
    }
  } catch { /* 没有运行时目录 */ }
  return best
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 用内置的 zcode.cjs 问出真实版本号（node zcode.cjs --version）。 */
async function cliVersion(cliPath) {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, '--version'], { timeout: 30_000 }, (error, stdout) => {
      const match = String(stdout ?? '').match(/(\d+\.\d+\.\d+)/)
      resolve(match?.[1] ?? undefined)
    })
  })
}

const glmDir = process.argv[2] ?? candidateGlmDirs().find((dir) => fs.existsSync(path.join(dir, 'zcode.cjs')))
if (glmDir === undefined) {
  console.error('没找到 ZCode 客户端的 glm 目录：请把客户端 resources/glm 路径作为参数传入')
  process.exit(1)
}
const cliSource = path.join(glmDir, 'zcode.cjs')
if (!fs.existsSync(cliSource)) {
  console.error(`客户端 glm 目录里没有 zcode.cjs：${glmDir}`)
  process.exit(1)
}

const builtinSource = findInstalledBuiltin()?.path
if (builtinSource === undefined) {
  console.error('没找到本机的 zcode-builtin.json（客户端没登录/没运行过？）；只同步 zcode.cjs，保留现有 builtin 种子')
}

fs.mkdirSync(VENDOR, { recursive: true })
fs.copyFileSync(cliSource, path.join(VENDOR, 'zcode.cjs'))
if (builtinSource !== undefined) {
  fs.copyFileSync(builtinSource, path.join(VENDOR, 'zcode-builtin.json'))
}

const manifestPath = path.join(VENDOR, 'manifest.json')
let manifest = {}
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch { /* 重建 */ }

manifest.cliVersion = (await cliVersion(path.join(VENDOR, 'zcode.cjs'))) ?? manifest.cliVersion
if (builtinSource !== undefined) {
  try {
    manifest.builtinRevision = JSON.parse(fs.readFileSync(path.join(VENDOR, 'zcode-builtin.json'), 'utf8')).revision
  } catch { /* 保留旧值 */ }
}
manifest.files ??= {}
manifest.files['zcode.cjs'] = { ...manifest.files['zcode.cjs'], sha256: sha256(path.join(VENDOR, 'zcode.cjs')) }
manifest.files['zcode-builtin.json'] = {
  ...manifest.files['zcode-builtin.json'],
  ...(builtinSource === undefined ? {} : { sha256: sha256(path.join(VENDOR, 'zcode-builtin.json')) }),
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`已同步内置运行时（来源：${glmDir}${builtinSource === undefined ? '' : ` + ${builtinSource}`}）`)
console.log(`  zcode.cjs            ${manifest.files['zcode.cjs'].sha256}`)
console.log(`  zcode-builtin.json   ${manifest.files['zcode-builtin.json']?.sha256 ?? '（保留原种子）'}`)
console.log(`  版本 ${manifest.cliVersion ?? '?'} · builtin revision ${manifest.builtinRevision ?? '?'}`)
