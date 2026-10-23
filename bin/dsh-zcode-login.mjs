#!/usr/bin/env node
/**
 * 独立登录命令：用插件内置的 zcode.cjs 跑一次 `login zai`（命令行方式，与设置页登录等效）。
 *
 *   npx dsh-zcode-login            # 或 node <插件目录>/bin/dsh-zcode-login.mjs
 *
 * 插件经 pnpm 装进 DSH profile 时，本文件在
 * `<profile>/node_modules/dsh-zcode-cli-proxy/bin/dsh-zcode-login.mjs`。
 * 不想用命令行也可以在 DSH 设置页里点「开始登录」。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = path.join(PLUGIN_DIR, 'vendor', 'zcode', 'zcode.cjs')
const BUILTIN = path.join(PLUGIN_DIR, 'vendor', 'zcode', 'zcode-builtin.json')

if (!fs.existsSync(CLI)) {
  console.error(`找不到内置的 ZCode 运行时：${CLI}（vendor/zcode/ 缺失？）`)
  process.exit(1)
}

const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir()
const manifest = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'vendor', 'zcode', 'manifest.json'), 'utf8'))
  } catch {
    return {}
  }
})()

const child = spawn(process.execPath, [CLI, 'login', 'zai'], {
  cwd: PLUGIN_DIR,
  stdio: 'inherit',
  env: {
    ...process.env,
    ZCODE_APP_VERSION: manifest.cliVersion ?? '0.17.0',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: BUILTIN,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(dataBaseDir, '.zcode', 'v2', 'provider_config.json'),
    ZCODE_BASE_URL: 'https://zcode.z.ai',
  },
})
child.on('exit', (code) => process.exit(code ?? 1))
