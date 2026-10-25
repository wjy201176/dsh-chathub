/**
 * chatHub — Client half.
 *
 * Adds the "chatHub" row to the left sidebar (below Plugins) and the panel it
 * selects. Selecting the panel asks the Host to open the chatHub Edge window;
 * the panel itself stays a small launcher and status card.
 */

window.__ModuleLoader__.load({
  id: 'dsh-chathub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'chathub'
    const PANEL_ID = 'chathub'

    const zh = {
      panel: 'chatHub',
      title: 'chatHub',
      intro: '一条提示词同时发给 ChatGPT、Gemini、Claude、DeepSeek 与 Grok，在独立 Edge 窗口中并排对比。',
      open: '打开 chatHub 窗口',
      reopen: '重新打开窗口',
      close: '关闭窗口',
      running: 'Edge 窗口已打开',
      stopped: 'Edge 窗口未打开',
      opening: '正在启动 Edge…',
      edgeMissing: '本机未找到 Microsoft Edge。',
      launchFailed: '无法启动 Edge 窗口。',
      notRunning: 'Edge 窗口未打开。',
      retry: '重试',
      panes: '模型分栏',
      cookies: '导入 Edge Cookie',
      cookiesDone: '已导入 {n} 条 Cookie',
      cookiesFailed: 'Cookie 导入失败：{e}',
      cookiesLocked: 'Edge 正在运行，Cookie 数据库被占用。请退出 Edge 后重试。',
      hint: '所有模型并排显示在同一个窗口中，底部是统一的提示词栏：文字、文件附件与语音输入。',
    }
    const en = {
      panel: 'chatHub',
      title: 'chatHub',
      intro: 'Ask one prompt to ChatGPT, Gemini, Claude, DeepSeek and Grok side by side in a dedicated Edge window.',
      open: 'Open chatHub window',
      reopen: 'Reopen window',
      close: 'Close window',
      running: 'Edge window is open',
      stopped: 'Edge window is closed',
      opening: 'Starting Edge…',
      edgeMissing: 'Microsoft Edge was not found on this machine.',
      launchFailed: 'Could not start the Edge window.',
      notRunning: 'The chatHub window is not open.',
      retry: 'Retry',
      panes: 'Model columns',
      cookies: 'Import Edge cookies',
      cookiesDone: 'Imported {n} cookies',
      cookiesFailed: 'Cookie import failed: {e}',
      cookiesLocked: 'Edge is running, so its cookie database is locked. Quit Edge and try again.',
      hint: 'Every model sits side by side in one window, with a shared prompt bar — text, file attachment and voice — along the bottom.',
    }

    const CSS = `
.chathub-page{display:flex;flex-direction:column;gap:16px;padding:28px 32px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.chathub-page h1{margin:0;font-size:20px;font-weight:600}
.chathub-page p{margin:0;color:var(--dsw-alias-label-secondary)}
.chathub-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-base)}
.chathub-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chathub-status{display:inline-flex;align-items:center;gap:7px;font-weight:500}
.chathub-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.chathub-dot[data-on="true"]{background:#3ecf8e}
.chathub-dot[data-tone="bad"]{background:#f0616d}
.chathub-btn{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.chathub-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.chathub-btn[data-kind="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand,#fff)}
.chathub-btn:disabled{opacity:.55;cursor:default}
.chathub-panes{display:flex;gap:8px;flex-wrap:wrap}
.chathub-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.chathub-error{color:var(--dsw-alias-label-error,#f0616d)}
.chathub-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
`

    let cssInstalled = false
    function ensureCss() {
      if (cssInstalled || typeof document === 'undefined') return
      cssInstalled = true
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-chathub'
      tag.dataset.pluginCss = 'dsh-chathub/page.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Resolve one of this plugin's host routes against the page base. */
    function hostRoute(path) {
      const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
      return new URL(path.replace(/^\/+/, ''), base).href
    }

    async function callApi(path, init) {
      const response = await fetch(hostRoute(`chathub/api/${path}`), {
        cache: 'no-store',
        ...init,
      })
      const payload = await response.json().catch(() => ({ ok: false, error: 'invalid response' }))
      return payload
    }

    function ChatHubIcon({ size }) {
      return h(
        'svg',
        {
          width: size ?? 16,
          height: size ?? 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 2.5, y: 4, width: 19, height: 14, rx: 2.5 }),
        h('path', { d: 'M7 18.5v2.2L10.6 18.5' }),
        h('path', { d: 'M8 8.5h8M8 12h5.5' }),
      )
    }

    function ChatHubPage({ t }) {
      ensureCss()
      const [state, setState] = React.useState({ phase: 'idle', running: false, error: null, panes: [] })
      const [note, setNote] = React.useState(null)
      const openedOnce = React.useRef(false)

      const refresh = React.useCallback(async () => {
        const payload = await callApi('state').catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
        if (payload.ok === true) {
          setState({ phase: 'ready', running: payload.value.running === true, error: payload.value.error ?? null, panes: payload.value.panes ?? [] })
        } else {
          setState((current) => ({ ...current, phase: 'ready', error: payload.error ?? 'state unavailable' }))
        }
      }, [])

      const open = React.useCallback(async () => {
        setState((current) => ({ ...current, phase: 'opening' }))
        const payload = await callApi('open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
        if (payload.ok === true) {
          setState({ phase: 'ready', running: payload.value.running === true, error: payload.value.error ?? null, panes: payload.value.panes ?? [] })
        } else {
          setState((current) => ({ ...current, phase: 'ready', error: payload.error ?? 'launch-failed' }))
        }
      }, [])

      const close = React.useCallback(async () => {
        await callApi('close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
        await refresh()
      }, [refresh])

      // Selecting the chatHub row lands here: open the Edge window the first
      // time this panel mounts in the page session.
      React.useEffect(() => {
        if (openedOnce.current) return
        openedOnce.current = true
        void open()
      }, [open])

      React.useEffect(() => {
        const timer = setInterval(() => { void refresh() }, 4000)
        return () => clearInterval(timer)
      }, [refresh])

      const importCookies = async () => {
        setNote(null)
        const payload = await callApi('cookies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        if (payload.ok === true) setNote({ tone: 'ok', text: t('cookiesDone').replace('{n}', String(payload.value.applied ?? payload.value.cookies ?? 0)) })
        else if (payload.error === 'cookies-locked') setNote({ tone: 'bad', text: t('cookiesLocked') })
        else setNote({ tone: 'bad', text: t('cookiesFailed').replace('{e}', String(payload.error ?? '')) })
      }

      const errorText = state.error === 'edge-missing'
        ? t('edgeMissing')
        : state.error === 'launch-failed' || String(state.error ?? '').startsWith('launch-failed')
          ? t('launchFailed')
          : state.error

      return h(
        'div',
        { className: 'chathub-page' },
        h('h1', null, t('title')),
        h('p', null, t('intro')),
        h(
          'div',
          { className: 'chathub-card' },
          h(
            'div',
            { className: 'chathub-row' },
            h(
              'span',
              { className: 'chathub-status' },
              h('span', { className: 'chathub-dot', 'data-on': String(state.running), 'data-tone': state.error ? 'bad' : undefined }),
              state.phase === 'opening' ? t('opening') : state.running ? t('running') : t('stopped'),
            ),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              {
                type: 'button',
                className: 'chathub-btn',
                'data-kind': 'primary',
                onClick: () => { void (state.running ? refresh() : open()) },
                disabled: state.phase === 'opening',
              },
              state.running ? t('reopen') : t('open'),
            ),
            state.running && h('button', { type: 'button', className: 'chathub-btn', onClick: () => { void close() } }, t('close')),
            state.running && h('button', { type: 'button', className: 'chathub-btn', onClick: () => { void importCookies() } }, t('cookies')),
          ),
          errorText ? h('div', { className: 'chathub-error' }, errorText) : null,
          note ? h('div', { className: note.tone === 'bad' ? 'chathub-error' : 'chathub-hint' }, note.text) : null,
          state.panes.length > 0 &&
            h(
              'div',
              { className: 'chathub-panes' },
              state.panes.map((pane) =>
                h('span', { className: 'chathub-chip', key: pane.id }, `${pane.title}${pane.targetId === null ? ' · waiting' : ''}`),
              ),
            ),
          h('div', { className: 'chathub-hint' }, t('hint')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'chathub: dictionaries',
        )
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 5,
              locale: NS,
              label: () => t('panel'),
            },
            ChatHubIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            ChatHubPage,
          ),
        )
      },
    }
  },
})
