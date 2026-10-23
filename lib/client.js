/* eslint-env browser */
/**
 * DSH 网页客户端半边：插件设置页（Plugins → 本 bundle 详情页）里的 ZCode 登录面板。
 *
 * 装配方式（与官方 ui-settings-* 页面同款）：
 *   - 宿主端 `dsh.client` 声明 + `exports["./client"]` 指到本文件，client module system
 *     按 Loader 行名 serve；本插件启用后浏览器半边随之加载；
 *   - 面板注册进 plugin-manager 页的 `plugins.bundle.config` 槽（按包名 keyed）；
 *   - 与宿主端的通信全部走设置文档的 volatile 字段（dsh-zcode-cli-proxy 命名空间）：
 *     按钮 form.set('login', …) 写动作 → 插件轮询到动作执行登录 → 插件经
 *     settings.write 写回 loginState / loginUrl → settings/document-updated 广播
 *     → 共享 describe 镜像刷新 → 本面板订阅的 form snapshot 更新 → UI 实时变化。
 *
 * 防御式加载：任何一步缺服务（老版本宿主 / 未组 ui-settings）都静默降级，不影响其他插件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-zcode-cli-proxy',
  factory: (require) => {
    let React
    try {
      React = require('react')
    } catch {
      React = undefined
    }

    const NS = 'dsh-zcode-cli-proxy'

    /** 模块级 inject（服务键）；缺了由 apply 内的防御分支兜住。 */
    const inject = ['configForms', 'slots']

    const el = (tag, props, ...children) => React.createElement(tag, props, ...children)

    /**
     * 登录面板。props: { form, view, entryKey }（face 来自 register 的 inject()，
     * view/entryKey 由 plugin-manager 的 renderSlot 传入）。
     */
    function ZcodeLoginPanel(props) {
      const form = props?.form ?? props?.face?.form
      const [snapshot, setSnapshot] = React.useState(() => (form !== undefined ? form.getSnapshot() : undefined))
      React.useEffect(() => {
        if (form === undefined) return undefined
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])

      if (form === undefined) {
        return el('div', { style: STYLES.panel },
          el('p', { style: STYLES.hint }, '设置服务不可用（ui-settings 未装配），无法在此登录。'))
      }
      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable === true
      const state = String(value.loginState ?? '')
      const url = String(value.loginUrl ?? '')
      const busy = state.startsWith('⏳')

      const act = (action) => {
        if (!writable) return
        try {
          void form.set('login', action)
        } catch (error) {
          console.warn('[dsh-zcode-cli-proxy] 登录动作写入失败', error)
        }
      }

      return el('div', { style: STYLES.panel, 'data-zcode-login': true },
        el('h3', { style: STYLES.title }, 'ZCode 账号登录'),
        el('p', { style: STYLES.hint },
          '登录后，模型请求将使用该 Z.AI 账号的 Start Plan / Coding Plan 额度（GLM 系列）。授权链接可在任何设备的浏览器打开，无需在本机操作。'),
        el('div', { style: STYLES.stateRow }, state === '' ? '（尚未发起登录）' : state),
        url !== '' && URL.canParse?.(url) !== false
          ? el('p', { style: STYLES.linkRow },
              el('a', { href: url, target: '_blank', rel: 'noreferrer noopener', style: STYLES.link }, '打开授权链接 ↗'),
              el('span', { style: STYLES.linkHint }, '（点击打开；手机上也可访问同一地址）'))
          : null,
        el('div', { style: STYLES.actions },
          el('button', { style: STYLES.primary, disabled: !writable || busy, onClick: () => act('start') }, '开始登录'),
          el('button', { style: STYLES.secondary, disabled: !writable || !busy, onClick: () => act('cancel') }, '取消'),
          el('button', { style: STYLES.secondary, disabled: !writable, onClick: () => act('logout') }, '退出登录')),
        !writable
          ? el('p', { style: STYLES.hint }, '当前命名空间不可写（宿主配置只读），无法在此发起登录。')
          : null,
      )
    }

    const STYLES = {
      panel: { maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' },
      title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' },
      hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary, #8a8f98)', fontSize: 13, lineHeight: '20px' },
      stateRow: {
        margin: 0, padding: '8px 10px', borderRadius: 8,
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
        color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, lineHeight: '20px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      linkRow: { margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      link: { color: 'var(--dsw-alias-state-business-primary, #4c6ef5)', fontSize: 13 },
      linkHint: { color: 'var(--dsw-alias-label-tertiary, #8a8f98)', fontSize: 12 },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      primary: {
        padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13,
        background: 'var(--dsw-alias-state-business-primary, #4c6ef5)', color: '#fff',
      },
      secondary: {
        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary, inherit)',
      },
    }

    /**
     * 挂载面板：宿主 serve 本插件的 volatile 表单命名空间时，注册进 Plugins 页的
     * bundle 配置槽。宿主不 serve（插件未启用 / 老版本）则面板自然缺席。
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: NS,
          inject: () => ({ form: ctx.configForms.get(NS) }),
        }, ZcodeLoginPanel))), 'zcode: login panel')
      } catch (error) {
        console.warn('[dsh-zcode-cli-proxy] 登录面板装配失败（不影响模型通道）', error)
      }
    }

    return { inject, apply }
  },
})
