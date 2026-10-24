# dsh-zcode cli反代（dsh-zcode-cli-proxy）

把 **DeepSeek Harness（DSH）** 的模型请求转交给 ZCode 客户端自带的 agent 执行的本地插件：
provider `zcode-cli` 走 GUI 同款的常驻 app-server 会话，插件把 ZCode **Start Plan** 账户注入 agent
并在每次请求前提供 OAuth 鉴权 —— **直接烧 ZCode Start Plan / Coding Plan 的额度**，
无需任何 API Key，也不需要自建网关。

仓库：<https://github.com/kyle123740/dsh-zcode-cli-proxy>

> **本仓库（IruNova 修改版）相对上游的改动**：
>
> 1. **设置页内登录**（0.5.0）：插件设置页里的「ZCode 账号登录」面板，任意设备的浏览器完成
>    OAuth 授权（见下文「登录」）；
> 2. **脱安装**：`vendor/zcode/` 内置 ZCode agent 运行时（zcode.cjs + builtin 配置种子），
>    本机不再需要安装 ZCode 客户端（详见下文「脱安装运行」）；
> 3. **模型参数不再写死**：contextWindow / maxOutputTokens 按 builtin 配置（CLI 同款
>    overlay + 大小写敏感匹配语义）现算生效值 —— 上游硬编码的 `200000 / 64000` 与
>    实机差数倍（GLM-5.3 系实际 1M / 128k），DSH 会因此提前压缩历史、低估输出预算
>    （此项修正与 [tangyixiao/dsh-zcode-plan-bridge](https://github.com/tangyixiao/dsh-zcode-plan-bridge)
>    的实测结论一致，一并致谢；其针对 npm 版 CLI 的其余改动与本仓库的桌面客户端通道不冲突）；
> 5. **纯直连通道**（0.7.0）：provider `zcode-direct`，Anthropic Messages 协议直发 Start Plan 端点——DSH 原生工具/权限/系统提示全生效，无 agent 的 12k 提示词开销（实现要点见下文「两条通道」；请求形状与设备绑定的逆向结论与 [magpie-community/plugins](https://github.com/magpie-community/plugins) 包 zcode 一致，致谢）;
> 4. **模型清单与推理档位**（0.6.0）：默认暴露 GLM-5.3 / GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo，
>    每个模型的推理档位（reasoningLevel）在 DSH 模型选择器里可调（实测校验集直通，
>    会话中途换档自动重切）—— 上游只硬编码 GLM-5.3-Flash 且写死 max 档；
> 遵循 AGPL-3.0，改动基于上游逆向成果，版权归上游作者。

> **原 zcode2api 网关已移除（2026-09-30）**：本插件最初是
> [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（ZCode 额度 → Anthropic Messages API
> 网关 + 账号池）的 DSH 集成。网关、账号池工具与一次性 CLI 通道已从本插件删除；
> 需要那些功能的请直接使用原版 zcode2api。

```
DSH Agent ──► provider "zcode-cli" ──► ZcodeAppServerAdapter
                                            │  spawn zcode.cjs app-server --stdio（常驻；内置 vendor/zcode/ 副本或客户端自带）
                                            ├─ provider/updateAccountConfig   注入 Start Plan 账户
                                            ├─ session/setModel               切到 Start Plan
                                            ├─ session/send                   发回合（真流式）
                                            └─ interaction/requestProviderRuntimeHeaders  回 OAuth 鉴权
                                                  └──► zcode.z.ai/api/v1/zcode-plan/anthropic
```

## 适配版本

| | |
| --- | --- |
| **实测通过** | DSH **2.0 桌面版 0.2.1-rc.2**（对照自带核心逐个核过：`ctx.llm.registerAdapter` / `registerConfigurableProviders`、`RetryPolicySchema` / `resolveRetryPolicy`、`ctx.get('attachments')` 均在位、签名未变；`turn-lock` 21/21 全绿）；以及 0.2.0-rc.2、0.1.7 线（cordis 4.0.5 / schemastery 3.18.5）。设置页登录在 0.2.1-rc.2 实机网页端全链路验证（面板渲染 → 发起 → 状态实时回写）；volatile 表单机制在 0.2.0-rc.2 的 `dsh-settings` 里逐字核对过，同一套实现 |
| **声明范围** | `dsh = ^0.1.5-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1 \|\| ^0.2.0-rc.2 \|\| ^0.2.1-rc.1 \|\| ^0.2.1-rc.2 \|\| ^0.2.1-rc.3`（写在 `package.json` 的 `dsh.engines.dsh`；覆盖 0.2.0-rc.2 → 0.2.1-rc.3） |
| **为什么不是一个 `>=`** | 预发布版本的 semver 规则很严：`>=0.1.5-rc.1` 对 `0.2.1-rc.2` 求值是 **false**（只有带同一 `major.minor.patch` 的比较项才接纳预发布版）。所以按线枚举，而不是写开区间 |

## 用法

DSH 设置 → 模型（Models）→ 提供方 **ZCode Start Plan（客户端反代）** → 模型 `GLM-5.3-Flash (ZCode CLI)`。
选中后 DSH 的模型请求会交给常驻的 ZCode app-server 执行，**烧的是你 ZCode 账号的 Start Plan 额度**
（执行渠道实测为 `account:zai-start-plan/GLM-5.3-Flash @ https://zcode.z.ai/api/v1/zcode-plan/anthropic`）。

- 真流式（text/reasoning delta 直接转发）、工具调用、图片输入（图片以本地文件随消息附上，agent 用 Read 读图）
- 多轮会话按 DSH 的 sessionId 复用 app-server 会话
- 会话标题这类辅助调用在本地生成，不消耗额度
- **设置页内登录**（见下「登录」）：无需命令行，任何设备的浏览器完成授权
- **本机无需安装 ZCode 客户端**：插件内置了从客户端拷出的 agent 运行时（`vendor/zcode/zcode.cjs`），
  自动探测不到本机客户端时直接用它（见下「脱安装运行」）；本机装了客户端则优先用客户端自带的

## 两条通道：直连（0.7.0 起）与 agent

插件注册**两个 provider**，模型列表里二选一：

| provider | 形态 | 特点 |
|---|---|---|
| `zcode-direct`（默认启用） | **纯直连**：Anthropic Messages 协议直发 Start Plan 端点，无 agent | DSH 的系统提示、工具、权限体系**原生生效**（结构化 tool_use 直接回 DSH 执行）；请求开销 ~1.5k tokens（无 agent 工具包）；会话标题本地生成 |
| `zcode-cli` | 托管 agent（上游原形态） | agent 的 Bash/Read 等原生工具在 agent 沙箱内执行（DSH 看不到）；每轮固定 ~12k 系统提示开销；工具不受 DSH 权限边界管 |

直连通道的实现要点（逆向自 ZCode 3.16.3 运行时的真实请求，与本仓库直连实验逐项验证）：

- system 恰好三块：块 0/1 **逐字节**等于 ZCode 原文（`lib/zcode-prompt.js` 快照），块 3 = 动态环境段 + DSH 的系统提示；第四块直接 405/3012；
- 头集精确等于 ZCode 3.16.3（只有 `Authorization: Bearer <zcodejwttoken>`，agent/SDK 注入的 `anthropic-beta`、`x-stainless-*` 等一律不发）；
- 首条用户消息是 `<system-reminder>` 当天日期；`metadata.user_id` 带持久化的设备号（首次生成，`X-Device-Mid` 同源）；
- start-plan 通道**无需任何签名**（V4 签名只服务 API-key 型 coding-plan 通道）；
- 推理档位：DSH 模型选择器的档位直通为 `thinking` + `output_config.effort`（GLM-5.3 系始终思考，不支持关闭——端点 1210 错误）。

> 直连通道的请求形状要求来自端点侧的强校验；ZCode 升级后形状若变，直连会以 405/3012 报错（错误信息带指引，可退回 agent 通道）。

## 可用模型与推理档位（0.6.0 起）

默认模型清单（DSH 模型选择器直接可选，且每个模型都能调推理档位）：

| DSH 模型 id | Start Plan 执行模型 | 上下文 | max 输出 | 可选推理档位 |
|---|---|---|---|---|
| `glm-5.3` | GLM-5.3 | 1M | 128k | low / high / max |
| `glm-5.3-flash` | GLM-5.3-Flash | 1M | 128k | low / high / max |
| `glm-5.2` | GLM-5.2 | 1M | 128k | disabled / high / max |
| `glm-5-turbo` | GLM-5-Turbo | 200k | 64k | disabled / enabled |

- 上下文 / max 输出按客户端 builtin 配置现算；推理档位是 `session/setModel` 的**实测校验集**
  （桌面 CLI 0.17.0 · Start Plan 通道，逐档探测得出——注意它和 builtin 配置里的通用规则不同）；
- 档位链路：DSH 模型选择器选档 → `GenerateOptions.reasoningEffort` → 适配器映射为
  `session/setModel` 的 `options.reasoningLevel`；会话中途换模型/换档自动重切；
- 想加别的条目在 `cliModels` 里配置：`startPlanModelId` 指到执行模型，
  `reasoningLevels`（可选档位表，低→高）与 `reasoningLevel`（默认档）可覆盖实测表。

## 登录（两种方式）

**方式一：DSH 设置页内登录（推荐，0.5.0 起）**

装好插件后打开 **DSH 侧边栏 → 插件 → dsh-zcode-cli-proxy**，页面顶部是「ZCode 账号登录」面板：

1. 点 **开始登录** —— 插件随即向 Z.AI 发起授权，页面实时出现「授权链接」；
2. 用**任意设备**的浏览器打开该链接完成确认（手机也行 —— 授权回调落在 zcode.z.ai 服务端，
   不要求浏览器与 DSH 同机；链接约 10 分钟内有效）；
3. 确认后面板显示「✅ 登录成功」，凭证写入 `~/.zcode/v2/credentials.json`，**立即生效、无需重启**。
   「取消」中止进行中的登录；「退出登录」清除共享凭证里的 Z.AI 登录。

面板字段（`login` / `loginState` / `loginUrl`）是 volatile 配置字段：只承载登录交互，
选择动作并保存即触发，不会导致插件重启。

**方式二：命令行登录**

```
npx dsh-zcode-login
# 或：node <本插件目录>/bin/dsh-zcode-login.mjs
```

它会用内置运行时打印授权链接（无头环境下复制链接到任意浏览器打开即可）。
凭证同样落在 `~/.zcode/v2/credentials.json`。

> 两种方式等价，任选其一；登录状态在面板上以 `loginState` 呈现。

## 脱安装运行（不再依赖本机装 ZCode 客户端）

`vendor/zcode/` 内置了 ZCode 桌面客户端 `resources/glm/` 里的 agent 运行时：

| 文件 | 作用 |
|------|------|
| `zcode.cjs` | ZCode CLI agent 运行时（app-server 通道的宿主进程），plain node ≥ 22.5 即可运行（实测 0.17.0；node:sqlite 依赖） |
| `zcode-builtin.json` | builtin provider 配置种子（Start Plan 注入的 configSource / basedOn 依据） |
| `manifest.json` | 来源、版本与 sha256 |

工作方式：

- `zcodeCliPath` 留空时依次探测：本机客户端（Windows/macOS/Linux 常见安装路径）→ 插件内置副本；
- `~/.zcode/v2/runtime/provider/` 下没有 `zcode-builtin.json`（客户端没跑过）时，builtin 配置回落到内置种子；
- 本机连 node 都没有时，回落到宿主进程自己的运行时（DSH 桌面版是 Electron，以 `ELECTRON_RUN_AS_NODE=1` 当 node 用）；
- 客户端 `resources/glm/packages/` 下的官方插件（browser-use、node-repl-host 等，100MB+）**不内置**：
  缺失时对应工具优雅降级，app-server 基础链路（会话 / 真流式 / Bash、Read 等原生工具）不受影响。

更新内置运行时（ZCode 客户端升级后）：

```
node scripts/sync-vendor.mjs [客户端resources/glm路径]   # 不带参数则自动探测
```

> 不想用内置副本（比如要强制跟客户端走）就把配置项 `allowBundledRuntime` 关掉。

## 安全须知（装之前必读）

这个「模型提供方」的真身是一个**以你当前用户权限运行、且带全套工具执行能力的 agent**：

- 插件建会话时把权限模式切到 `yolo`，并对 agent 的每一次 `interaction/requestPermission`
  自动回 `allow` —— agent 执行 Bash、读写文件、联网等操作**不会弹任何确认**。
- agent 的输入是 DSH 拍平后的整段对话（含网页抓取、工具结果等外部内容）。这些内容里若被
  塞入注入指令，agent 可能据此执行命令 —— 请只在可信场景使用，不要把不可信网页内容喂进
  挂着本插件的会话。
- 子进程环境变量按白名单透传（系统基础变量、`ZCODE_*`、`NODE_EXTRA_CA_CERTS`），不继承
  DSH 宿主的全部 env；确有需要可用配置项 `childEnvAllow` 追加变量名。
- 鉴权 token（`zcodejwttoken`）只经本机 stdio JSON-RPC 交给 agent 进程，不发往任何第三方。

## 通道原理（2026-09-30 逆向打通，全部实测）

1. spawn `zcode app-server` 时按 GUI 同款设置 `ZCODE_APP_VERSION` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BASE_URL`（否则 CLI 落在 0.0.0-dev 目录，注入对不上）；
2. `provider/updateAccountConfig` 注入 `account:zai-start-plan`（entitled）。**关键坑**：
   `basedOnZCodeBuiltinRevision` 必须逐字符等于 configSource 的
   `zcode-builtin:<revision>:<sha256(activeFilePath)>`，否则 registry 合并循环**静默跳过**（不报错）；
3. `session/setModel`（0.16.9 起要求对象式 `{providerId, modelId, options:{reasoningLevel}}`，level 必填，GUI 用 max）；
4. agent 发模型请求前回调 `interaction/requestProviderRuntimeHeaders` 要鉴权 —— 回共享凭证里的
   **`zcodejwttoken`**（`oauth:zai:access_token` 已过期，回它上游 401）。agent 自己算 coding-plan 请求签名，能过 WAF；
5. `session/event` 的事件类型在 **params.type 顶层**（不是 payload.type），`turn.failed` 也要处理，
   `replayState` 里不能有 `undefined` 字段（lossless JSON 校验会炸）。
6. **模型参数不写死**：DSH 侧的 contextWindow / max_tokens 按 builtin 配置（`zcode-builtin.json`
   的 `modelConfigRules.modelRules`，CLI 同款 overlay + 大小写敏感全串匹配语义）现算生效值 ——
   GLM-5.3 系实际是 1M 上下文，写死 200k 会差 5 倍（DSH 会提前压缩历史、低估输出预算）。

> HTTP 直连计划端点会被阿里云无痕验证拦（3007/3012）——只有 agent 二进制自己发的签名请求能过，
> 所以「反代」的形态是托管 agent 进程而不是自建 HTTP 网关。

## 回合锁与自愈

app-server **一个会话同时只允许一个在途回合**。上一轮被中止 / 超时 / 静默丢弃时它不会自己释放，
下一轮 `session/send` 就被拒成 `A prompt is already running for this session`（DSH 里显示成
「本轮运行失败 · PROVIDER」，因为文案是逐字透传上游的 JSON-RPC 错误）。通道层做六件事兜底：

1. **补发 `session/stop`**：本轮只要没正常结束（超时 / 被中止 / 发送失败 / `turn.failed`），
   生成器 `finally` 一定补一刀，不把锁留给下一轮；
2. **撞锁自愈**：`send` 被回「already running」→ 补 stop → 等 1.5s → 原会话重试一次；
   被回「session … not found」（会话被回收 / 进程重启）→ 丢弃缓存条目、新建会话，
   `firstTurn` 语义自动重放整段对话，历史不丢；
3. **回合串行化**：同一 DSH 会话的两轮排队跑（最多等 60s，超时放行交给 2 处理），
   并发请求不再直接撞错；
4. **进程退出即作废 + 快败**：app-server 子进程退出（含 spawn 失败）时清空会话映射，
   避免下一轮拿悬空 sessionId 去发；**在途的流会立刻收到一个回合失败收尾**，
   不用干等回合超时（默认 15 分钟）；spawn 的 `error` 事件也接住了，不会打挂宿主。
5. **会话分叉检测**：每轮 send 都记录当时的消息列表指纹；下一轮续接前先比对前缀，
   DSH 侧编辑 / 回退过历史就重建会话、按首轮语义重放新分支，避免模型看着旧历史答新问题。
6. **模型映射**：DSH 选中的模型 id 经 `cliModels[].startPlanModelId` 映射到真实的
   Start Plan 执行模型；同一会话中途换模型时在原会话上重发 `session/setModel`。

回归验证（不需要真 ZCode 客户端与额度，跑的是假 app-server）：

```
node test\turn-lock.mjs        # 撞锁自愈 / 串行化 / 中止补刀 / 重启作废 / 会话失效重放 / 退出快败 / 分叉重建
```

## 配置（设置 → 插件）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `zcodeCliPath` | 自动探测 | ZCode 客户端自带的 zcode.cjs 路径；留空 = 先探测本机客户端，再回落插件内置副本 |
| `zcodeCliNode` | `node` | 运行 zcode.cjs 的 node 可执行文件；本机没有 node 时自动改用宿主运行时（Electron 以 ELECTRON_RUN_AS_NODE 模式） |
| `allowBundledRuntime` | `true` | 允许使用插件内置的 ZCode 运行时（vendor/zcode/），本机没装客户端也能跑 |
| `cliModels` | `glm-5.3-flash` | provider `zcode-cli` 暴露给 DSH 的模型清单；`startPlanModelId` 字段把条目映射到真实的 Start Plan 执行模型（缺省 `GLM-5.3-Flash`） |
| `cliCwd` | 空 | app-server 会话的工作目录；留空 = 用户主目录 |
| `injectStartPlanAccount` | `true` | 把 Start Plan 账户注入 agent（GUI 同款） |
| `zcodeDataBaseDir` | 空 | ZCode 共享凭证目录（读 `zcodejwttoken`）；留空 = 用户主目录 |
| `childEnvAllow` | `[]` | 额外透传给 app-server 子进程的环境变量名（默认只透传系统基础变量、`ZCODE_*` 与 `NODE_EXTRA_CA_CERTS`） |
| `appServerTimeoutMs` | `120000` | app-server 单次请求超时（毫秒） |
| `zcodeCliTimeoutMs` | `900000` | app-server 单回合超时（毫秒） |
| `login` | `idle` | volatile 登录动作（设置页面板用）：`start` / `cancel` / `logout`，保存即触发 |
| `loginState` / `loginUrl` | 空 | volatile 登录状态与授权链接（插件自动写入，面板展示） |

## 开发：改了代码怎么生效

**桌面版**（`C:\Users\zy\.dsh\profiles\desktop`，bundle 以 `link:` 挂载）：
没有热重载，改完 `lib\*.js` 后**重启 DeepSeek Harness** 即生效。

**网页版 / file:// 装配**：DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，
而 Node ESM 以完整 URL（含查询串）为缓存键。仓库里的 `cordis.patch.yml` 写的是包名
`dsh-zcode-cli-proxy`（npm / link: 装配的正确形态）；本地目录式开发装配时把它换成
file:// URL 加 `?v=N`：

```yaml
# cordis.patch.yml（仅本地开发，勿提交）
- insert:
    - id: dsh-zcode-cli-proxy
      name: 'file:///E:/ai/dsh/plugins/dsh-zcode-cli-proxy/lib/index.js?v=N'
```

改完 `lib\*.js` 后：把 `?v=N` 递增，然后在插件管理里对 bundle
**禁用 → 启用**（或重启 DSH），新代码即生效。
（重启 DSH 永远有效；忘记 bump 版本号则只会重跑旧代码。）

## 目录结构

```
lib/index.js        插件装配：Config schema、provider 注册、登录面板宿主端
lib/app-server.js   app-server 通道：JSON-RPC 客户端 + LlmAdapter（Start Plan 注入/鉴权/事件流）
lib/login.js        Z.AI 登录引擎（CLI 同款 OAuth 协议：init → 授权链接 → 轮询 → 写凭证）
lib/client.js       网页客户端半边：插件设置页里的登录面板（plugins.bundle.config 槽）
lib/bundled.js      内置运行时（vendor/zcode/）的路径与 manifest 读取
lib/messages.js     共用消息工具：图片落盘、对话拍平
lib/credentials.js  ~/.zcode/v2/credentials.json 的读解密 / 写加密
vendor/zcode/       内置的 ZCode agent 运行时（zcode.cjs + builtin 配置种子 + manifest）
bin/                dsh-zcode-login：命令行登录入口
scripts/            Start Plan 通道的逆向探测脚本（probe-*.cjs）；sync-vendor.mjs 更新内置运行时
test/               app-server 通道与凭证解密的验证脚本
                    turn-lock.mjs + fake-app-server.cjs：回合锁自愈的回归测试
```

> 普通配置项（`zcodeCliPath` / `cliModels` 等）不走设置表单（DSH 设置表单只暴露 volatile
> 字段），按 DSH 常规方式编辑 profile 的 cordis 配置；登录交互才在设置页里进行。

## 许可

AGPL-3.0。本插件的 app-server 通道实现独立于上游，仅将
[liu5269/zcode2api](https://github.com/liu5269/zcode2api) 作为历史来源致谢；
上游代码已不再随本仓库分发，其本身遵循 AGPL-3.0，仅限学习、研究、个人实验用途。
