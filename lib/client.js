// dsh-mcp-pill — client half (official __ModuleLoader__ web bundle)
//
// Browser-only bundle: consumed by the DSH web loader (window.__ModuleLoader__).
// Not importable in Node. Renders the MCP status pill + panel; the pill snaps
// to one of the chat input's four corners (drag to switch), position is
// remembered in localStorage.
//
// The pill is hidden by DEFAULT: an official-style expandable Settings Card
// under settings.plugin.item / key mcp-pill owns the「显示状态胶囊」switch
// (pill.enabled, default false), and the polled /api/mcp-pill/status payload
// (`pill.enabled`, hot host mirror) decides whether the pill shows at all.
//
// Lifecycle: every DOM node, observer, timer, rAF and listener created by
// startPill() is registered with the idempotent disposer returned through
// ctx.effect(), so stop / update / HMR release everything — including a drag
// that is still in flight — and a later apply re-mounts from scratch.

window.__ModuleLoader__.load({
  id: 'dsh-mcp-pill',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const e = React.createElement

    const NS = 'mcp-pill'
    const API = '/api/mcp-pill'
    // Dynamic polling intervals (ms): active when any MCP enabled, idle when all disabled
    const POLL_INTERVALS = Object.freeze({
      ACTIVE: 3000, // When at least one MCP is enabled
      IDLE: 10000,  // When all MCPs are disabled
      ERROR: 5000,  // When last fetch failed
    })
    const ENSURE_MS = 2000
    const ROOT_ID = 'dsh-mcp-pill-root'
    const ANCHOR_KEY = 'dsh.mcpPill.anchor'
    const ANCHORS = Object.freeze(['tl', 'tr', 'bl', 'br'])

    // Mounted flag owned by the plugin lifecycle: set when the pill starts and
    // reset by the idempotent disposer, so a later apply (update / HMR / re-run)
    // mounts a fresh pill instead of being blocked by a stale flag.
    let pillMounted = false
    let pillDispose = null

    // ── settings card (official-style, same chrome as the ADAPT card) ───────

    const FIELDS = [
      { path: ['pill', 'enabled'], kind: 'bool', label: '显示状态胶囊', hint: '默认关闭。开启后 MCP 连接状态胶囊显示在输入框旁；拖动胶囊可吸附四角。' },
    ]

    function isPlainObject(v) {
      return v !== null && typeof v === 'object' && !Array.isArray(v)
    }

    function getAt(obj, path) {
      let cur = obj
      for (const key of path) {
        if (!isPlainObject(cur) || !(key in cur)) return undefined
        cur = cur[key]
      }
      return cur
    }

    function formatValue(field, value) {
      if (field.kind === 'bool') return value ? 'true' : 'false'
      return ''
    }

    function parseValue(field, text) {
      if (field.kind === 'bool') return text === true || text === 'true'
      return undefined
    }

    function fieldKey(path) {
      return path.join('.')
    }

    // Official PluginCard chrome cannot be imported by an out-of-repo plugin
    // (bundle purity). Recreate the same disclosure card so MCP Pill sits in
    // the Plugins list as one expandable <li> beside Shell / Agent loop.
    const CARD_CSS_ID = 'dsh-mcp-pill/plugin-card'
    const CARD_CSS = [
      '.dmpCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      '.dmpCard:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dmpCardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dmpHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.dmpHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dmpHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.dmpName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.dmpDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.dmpChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      '.dmpChevronOpen{transform:rotate(180deg)}',
      '.dmpBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dmpReadOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
      '.dmpPending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      '.dmpFooter{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.dmpFailed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.dmpDiscard,.dmpSave{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.dmpDiscard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.dmpDiscard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dmpSave{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dmpDiscard:disabled,.dmpSave:disabled{opacity:.4;cursor:default}',
      '.dmpDiscard:focus-visible,.dmpSave:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dmpField{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.dmpField+.dmpField{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dmpFieldHead{align-items:center;gap:8px;display:flex}',
      '.dmpLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      '.dmpBadges{align-items:center;gap:8px;display:inline-flex}',
      '.dmpBadge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      '.dmpReset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
      '.dmpReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dmpHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.dmpSwitch{appearance:none;width:36px;height:20px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);position:relative;cursor:pointer;flex:none}',
      '.dmpSwitch::after{content:"";width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);position:absolute;top:2px;left:2px;transition:transform .16s,background .16s}',
      '.dmpSwitch:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dmpSwitch:checked::after{background:var(--dsw-alias-bg-layer-3);transform:translateX(16px)}',
      '.dmpSwitch:disabled{opacity:.4;cursor:default}',
      '.dmpSwitch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    ].join('')

    function ensureCardStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CARD_CSS_ID) + ']')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-mcp-pill'
      tag.dataset.pluginCss = CARD_CSS_ID
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
    }

    // Idempotent inverse of ensureCardStyles(): removed on stop / update /
    // HMR so no style tag is left behind; a later render re-creates it.
    function removeCardStyles() {
      if (typeof document === 'undefined') return
      const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(CARD_CSS_ID) + ']')
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
    }

    function Chevron(props) {
      return e('svg', {
        width: 14,
        height: 14,
        className: props.className,
        viewBox: '0 0 14 14',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true,
      }, e('path', {
        d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
        fill: 'currentColor',
      }))
    }

    function FieldRow(props) {
      const head = [
        e('label', { key: 'lab', className: 'dmpLabel', htmlFor: props.id }, props.label),
      ]
      if (props.overridden) {
        head.push(e('span', { key: 'badges', className: 'dmpBadges' },
          e('span', { className: 'dmpBadge' }, '已覆盖'),
          e('button', {
            type: 'button',
            className: 'dmpReset',
            disabled: props.disabled,
            onClick: props.onReset,
          }, '恢复默认'),
        ))
      }
      return e('div', { className: 'dmpField' },
        e('div', { className: 'dmpFieldHead' }, head),
        e('input', {
          id: props.id,
          className: 'dmpSwitch',
          type: 'checkbox',
          checked: props.text === 'true',
          disabled: props.disabled,
          onChange: (ev) => props.onEdit(ev.target.checked ? 'true' : 'false'),
        }),
        e('p', { className: 'dmpHint' }, props.hint || null),
      )
    }

    function SettingsCard(props) {
      ensureCardStyles()
      const scope = props.scope
      const api = props.api
      const [tick, setTick] = React.useState(0)
      const [open, setOpen] = React.useState(false)
      const [staged, setStaged] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        if (!scope || typeof scope.subscribe !== 'function') return undefined
        return scope.subscribe(() => setTick((n) => n + 1))
      }, [scope])

      const snap = scope && typeof scope.getSnapshot === 'function'
        ? scope.getSnapshot()
        : { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }

      const available = snap.status === 'ready'
      const writable = !!snap.writable
      const value = snap.value || {}
      const base = snap.base || {}
      const user = snap.user || {}

      const plan = []
      for (const field of FIELDS) {
        const key = fieldKey(field.path)
        const draft = staged[key]
        if (!draft) continue
        if (draft.clear) {
          if (getAt(user, field.path) !== undefined) plan.push({ op: 'unset', path: field.path })
          continue
        }
        const parsed = parseValue(field, draft.text)
        if (formatValue(field, getAt(value, field.path)) === formatValue(field, parsed)) continue
        plan.push({ op: 'set', path: field.path, value: parsed })
      }

      const dirty = plan.length > 0
      const blocked = !dirty || saving

      function stage(field, next) {
        setFailed(false)
        setStaged((prev) => Object.assign({}, prev, { [fieldKey(field.path)]: next }))
      }

      function discard() {
        if (!dirty && !failed) return
        setStaged({})
        setFailed(false)
      }

      async function save() {
        if (!api || !api.settings || saving || !dirty || !writable) return
        setSaving(true)
        setFailed(false)
        try {
          const ops = plan.map((item) => (
            item.op === 'unset'
              ? { op: 'unset', path: item.path }
              : { op: 'set', path: item.path, value: item.value }
          ))
          const payload = { ns: NS, ops }
          if (snap.revision !== undefined) payload.expectedRevision = snap.revision
          const response = await api.settings.mutate(payload)
          const ok = !!(response && response.result && response.result.ok)
          if (ok) setStaged({})
          else setFailed(true)
        } catch (_) {
          setFailed(true)
        }
        setSaving(false)
      }

      void tick
      if (!available) return null

      const fields = FIELDS.map((field) => {
        const key = fieldKey(field.path)
        const draft = staged[key]
        const current = getAt(value, field.path)
        const stored = getAt(user, field.path) !== undefined
        const overridden = draft
          ? !draft.clear
          : stored
        const text = draft ? draft.text : formatValue(field, current)
        return e(FieldRow, {
          key,
          id: 'plugin-config-mcp-pill-' + key.replace(/\./g, '-'),
          kind: field.kind,
          label: field.label,
          hint: field.hint,
          text,
          overridden,
          disabled: !writable || saving,
          onEdit: (next) => stage(field, { text: next, clear: false }),
          onReset: () => stage(field, { text: formatValue(field, getAt(base, field.path)), clear: true }),
        })
      })

      const body = open ? e('div', { className: 'dmpBody' },
        writable ? null : e('p', { className: 'dmpReadOnly', role: 'status' }, '本部署的设置为只读。'),
        fields,
        e('div', { className: 'dmpFooter' },
          failed ? e('p', { className: 'dmpFailed', role: 'status' }, '本部署没有接受这些值，已保留供你修改。') : null,
          e('button', {
            type: 'button',
            className: 'dmpDiscard',
            disabled: !dirty || saving,
            onClick: discard,
          }, '放弃修改'),
          e('button', {
            type: 'button',
            className: 'dmpSave',
            disabled: blocked || !writable,
            onClick: save,
          }, saving ? '保存中…' : '保存'),
        ),
      ) : null

      return e('li', { className: open ? 'dmpCard dmpCardOpen' : 'dmpCard' },
        e('button', {
          type: 'button',
          className: 'dmpHeader',
          'aria-expanded': open,
          'aria-label': (open ? '收起设置' : '展开设置') + ': MCP Pill',
          onClick: () => setOpen(!open),
        },
          e('span', { className: 'dmpHeadText' },
            e('span', { className: 'dmpName' }, 'MCP Pill'),
            e('span', { className: 'dmpDescription' }, 'MCP 连接状态胶囊。默认隐藏，开启后显示在输入框旁。'),
          ),
          dirty ? e('span', { className: 'dmpPending' }, '未保存') : null,
          e(Chevron, { className: open ? 'dmpChevron dmpChevronOpen' : 'dmpChevron' }),
        ),
        body,
      )
    }

    // ── composer pill ───────────────────────────────────────────────────────

    function startPill(scope) {
      if (typeof document === 'undefined' || !document.documentElement) return
      if (pillMounted) {
        // Previous mount leaked (disposal was skipped). Dispose it first, then
        // mount again: every apply must end with exactly one live pill.
        const previous = pillDispose
        pillDispose = null
        if (typeof previous === 'function') previous()
        return startPill()
      }
      pillMounted = true

      // Idempotent re-mount: drop any root a previous bundle left behind
      // before creating a fresh one.
      const stale = document.getElementById(ROOT_ID)
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale)

      const cleanups = []
      const track = (fn) => cleanups.push(fn)

      let disposed = false
      let root = null
      let dragCleanup = null

      // Mount target is ONLY the composer seat. There is deliberately no
      // document.body fallback (and no composer-card-parent fallback): the pill
      // must stay inside the composer stacking context so DSH overlays can
      // cover it. While the seat has not appeared yet the root stays detached,
      // so no off-page pill floats over the UI; the document observer below
      // mounts it as soon as [data-composer-seat] exists.
      function findSeat() {
        return document.querySelector('[data-composer-seat]')
      }
      function ensureMounted() {
        const seat = findSeat()
        if (!seat) return false
        if (root.parentNode !== seat || !root.isConnected) seat.appendChild(root)
        return true
      }

      root = document.createElement('div')
      root.id = ROOT_ID
      // Hidden by default (pill.enabled defaults to false): the visibility
      // gate below reveals it only once /status reports pill.enabled === true.
      root.style.cssText = 'position:fixed;z-index:1;display:none;font-family:ui-sans-serif,system-ui,sans-serif;'

      const shadow = root.attachShadow({ mode: 'open' })
      shadow.innerHTML = '<style>' + [
        ':host{all:initial}',
        '.pill{display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l1,#444);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#222);color:var(--dsw-alias-label-primary,#eee);font-size:12px;cursor:grab;box-shadow:0 2px 8px rgba(0,0,0,.25);user-select:none;touch-action:none}',
        '.pill:active{cursor:grabbing}',
        '.pill:hover{border-color:var(--dsw-alias-brand-primary,#4a9eff)}',
        '.dot{width:8px;height:8px;border-radius:50%;display:inline-block}',
        '.dot.ok{background:var(--dsw-alias-state-success-primary,#3fb950)}',
        '.dot.busy{background:var(--dsw-alias-state-warn-primary,#d29922)}',
        '.dot.off{background:var(--dsw-alias-label-secondary,#999)}',
        '.panel{position:fixed;right:0;bottom:calc(100% + 8px);width:320px;max-height:70vh;overflow:auto;display:none;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1,#444);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#222);color:var(--dsw-alias-label-primary,#eee);font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}',
        '.panel.open{display:flex}',
        '.head{display:flex;align-items:center;gap:8px}',
        '.head b{font-size:13px}',
        '.head .count{margin-left:auto;color:var(--dsw-alias-label-secondary,#999);font-size:11px}',
        '.err{color:var(--dsw-alias-state-error-primary,#f85149);font-size:11px;word-break:break-all}',
        '.entry{border:1px solid var(--dsw-alias-border-l1,#444);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:4px}',
        '.row{display:flex;align-items:center;gap:6px}',
        '.srv{font-family:ui-monospace,Consolas,monospace;font-weight:600}',
        '.meta{color:var(--dsw-alias-label-secondary,#999);font-size:11px}',
        '.btn{margin-left:auto;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2,#666);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:11px;cursor:pointer}',
        '.btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4a9eff);color:var(--dsw-alias-brand-primary,#4a9eff)}',
        '.btn:disabled{opacity:.5;cursor:default}',
        '.tools{display:flex;flex-wrap:wrap;gap:4px}',
        '.tool{font-family:ui-monospace,Consolas,monospace;font-size:10px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#333);color:var(--dsw-alias-label-secondary,#bbb)}',
        '.empty{color:var(--dsw-alias-label-secondary,#999);font-size:11px;padding:2px 0}',
        '.close{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#999);cursor:pointer;font-size:13px;padding:0 2px}',
        '.close:hover{color:var(--dsw-alias-label-primary,#eee)}'
      ].join('') + '</style>'

      const state = { entries: [], error: null, busyId: null, open: false }

      // ── poll scheduling ────────────────────────────────────────────────────
      // One interval is armed for the whole pill life. After every refresh it
      // is re-armed with the interval that fits the latest entries/error
      // state (slower while everything is disabled, faster again after a
      // toggle or while errors persist), and skipped when the interval did
      // not change so the cadence stays stable. Every status/toggle fetch is
      // bounded by FETCH_TIMEOUT_MS so a hung request can neither stall the
      // poll nor wedge a button; in-flight controllers live in `inFlight` and
      // disposePill aborts them all.
      const FETCH_TIMEOUT_MS = 10000
      let pollTimer = null
      let armedMs = null
      const inFlight = new Set()

      function nextPollMs() {
        if (state.error) return POLL_INTERVALS.ERROR
        return state.entries.some((e) => e.enabled)
          ? POLL_INTERVALS.ACTIVE
          : POLL_INTERVALS.IDLE
      }

      function armPoll(ms) {
        if (disposed) return
        if (ms === armedMs && pollTimer !== null) return // unchanged — keep cadence
        if (pollTimer !== null) clearInterval(pollTimer)
        armedMs = ms
        pollTimer = setInterval(refresh, ms)
      }

      async function boundedFetch(url, init) {
        const controller = new AbortController()
        const timer = setTimeout(function () { controller.abort() }, FETCH_TIMEOUT_MS)
        inFlight.add(controller)
        try {
          return await fetch(url, Object.assign({}, init, { signal: controller.signal }))
        } finally {
          clearTimeout(timer)
          inFlight.delete(controller)
        }
      }

      const pill = document.createElement('button')
      pill.className = 'pill'
      pill.title = 'MCP 连接状态（点击查看工具；拖动可吸附到输入框四角）'
      const pillDot = document.createElement('span')
      pillDot.className = 'dot off'
      const pillText = document.createElement('span')
      pillText.textContent = 'MCP'
      pill.append(pillDot, pillText)

      const cluster = document.createElement('div')
      cluster.style.cssText = 'display:flex;align-items:center'
      cluster.append(pill)

      const panel = document.createElement('div')
      panel.className = 'panel'
      const head = document.createElement('div')
      head.className = 'head'
      const title = document.createElement('b')
      title.textContent = 'MCP 连接'
      const count = document.createElement('span')
      count.className = 'count'
      const closeBtn = document.createElement('button')
      closeBtn.className = 'close'
      closeBtn.textContent = '✕'
      head.append(title, count, closeBtn)
      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-direction:column;gap:8px'
      panel.append(head, list)

      shadow.append(cluster, panel)

      // ── composer-anchored: snaps to one of the input's four corners ────
      // [data-composer-card] is the input card, [data-composer-seat] its
      // dock. Drag to the quadrant you want and it snaps to that corner;
      // the pill only exists while the seat does, so it never floats on
      // the body when the composer is gone.

      let anchor = 'br'
      try {
        const saved = localStorage.getItem(ANCHOR_KEY)
        if (saved === 'left') anchor = 'bl' // legacy value
        else if (saved === 'right') anchor = 'br' // legacy value
        else if (ANCHORS.indexOf(saved) !== -1) anchor = saved
      } catch (_) {}

      root.style.right = '16px'
      root.style.bottom = '16px'

      let lastX = null
      let lastY = null
      let dragging = false

      function findComposer() {
        return document.querySelector('[data-composer-card]') || findSeat() || null
      }

      function place() {
        if (dragging || !root.isConnected) return // mid-drag or not mounted yet
        const seat = findComposer()
        if (!seat) return
        const r = seat.getBoundingClientRect()
        const pr = cluster.getBoundingClientRect()
        const gap = 8
        const leftSide = anchor === 'tl' || anchor === 'bl'
        const topSide = anchor === 'tl' || anchor === 'tr'
        let x = leftSide ? r.left - pr.width - gap : r.right + gap
        let y = topSide ? r.top - pr.height - gap : r.bottom + gap
        x = Math.max(4, Math.min(window.innerWidth - pr.width - 4, x))
        y = Math.max(4, Math.min(window.innerHeight - pr.height - 4, y))
        if (x === lastX && y === lastY) return
        lastX = x
        lastY = y
        root.style.left = x + 'px'
        root.style.top = y + 'px'
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        if (panel.classList.contains('open')) placePanel()
      }

      let rafId = 0
      let rafPending = false
      function schedulePlace() {
        if (disposed || rafPending) return
        rafPending = true
        rafId = requestAnimationFrame(function () {
          rafPending = false
          rafId = 0
          place()
        })
      }

      // Wait for [data-composer-seat]: observe the whole document so the pill
      // mounts whenever the seat first appears and follows later re-inserts.
      const domObserver = new MutationObserver(function () {
        if (ensureMounted()) schedulePlace()
      })
      domObserver.observe(document.documentElement, { childList: true, subtree: true })
      track(function () { domObserver.disconnect() })

      // Follow the composer: size changes (multiline input), window resizes,
      // and any scroll container moving it.
      window.addEventListener('scroll', schedulePlace, { capture: true, passive: true })
      track(function () { window.removeEventListener('scroll', schedulePlace, { capture: true }) })

      window.addEventListener('resize', schedulePlace)
      track(function () { window.removeEventListener('resize', schedulePlace) })

      const seatRo = new ResizeObserver(schedulePlace)
      let seatObserved = null
      function watchSeat() {
        const seat = findComposer()
        if (seat && seat !== seatObserved) {
          if (seatObserved) seatRo.unobserve(seatObserved)
          seatRo.observe(seat)
          seatObserved = seat
        }
      }
      watchSeat()
      track(function () { seatRo.disconnect() })

      const seatTimer = setInterval(function () {
        ensureMounted() // React may have re-rendered the composer seat away
        watchSeat()
        place()
      }, ENSURE_MS)
      track(function () { clearInterval(seatTimer) })

      // Drag to switch corners: while dragging the pill follows the pointer;
      // on release it snaps to the corner matching the quadrant the pill
      // center landed in (left/right × top/bottom) and remembers it.
      let lastDragAt = 0
      function onPointerDown(ev) {
        if (ev.button !== 0 || disposed) return
        ev.preventDefault()
        dragging = true
        panel.classList.remove('open')
        const startX = ev.clientX
        const startY = ev.clientY
        const startLeft = root.getBoundingClientRect().left
        const startTop = root.getBoundingClientRect().top
        let moved = false
        const prevSelect = document.body.style.userSelect
        document.body.style.userSelect = 'none'
        function onMove(mv) {
          const dx = mv.clientX - startX
          const dy = mv.clientY - startY
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
          root.style.left = (startLeft + dx) + 'px'
          root.style.top = (startTop + dy) + 'px'
          root.style.right = 'auto'
          root.style.bottom = 'auto'
        }
        function onUp() {
          dragCleanup = null
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)
          document.body.style.userSelect = prevSelect
          dragging = false
          if (!moved) return
          lastDragAt = Date.now()
          const rect = root.getBoundingClientRect()
          const cx = rect.left + rect.width / 2
          const cy = rect.top + rect.height / 2
          const seat = findComposer()
          if (seat) {
            const r = seat.getBoundingClientRect()
            const leftSide = cx < r.left + r.width / 2
            const topSide = cy < r.top + r.height / 2
            anchor = (topSide ? 't' : 'b') + (leftSide ? 'l' : 'r')
            try { localStorage.setItem(ANCHOR_KEY, anchor) } catch (_) {}
          }
          lastX = null
          lastY = null
          place()
        }
        // Disposal during an active drag must still release the document-level
        // listeners and restore the body selection style.
        dragCleanup = function () {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)
          document.body.style.userSelect = prevSelect
          dragging = false
        }
        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
      }
      cluster.addEventListener('pointerdown', onPointerDown)
      track(function () { cluster.removeEventListener('pointerdown', onPointerDown) })

      function placePanel() {
        // The panel is positioned in VIEWPORT coordinates so it follows the
        // pill wherever it sits.
        panel.style.position = 'fixed'
        const r = cluster.getBoundingClientRect()
        const pw = panel.offsetWidth || 320
        const ph = panel.offsetHeight || 320
        let left = r.left
        const maxLeft = Math.max(4, window.innerWidth - pw - 4)
        if (left > maxLeft) left = maxLeft
        if (left < 4) left = 4
        const below = window.innerHeight - r.bottom - 8 >= ph || r.top < ph + 8
        if (below) {
          panel.style.left = left + 'px'
          panel.style.top = (r.bottom + 8) + 'px'
          panel.style.right = 'auto'
          panel.style.bottom = 'auto'
        } else {
          panel.style.left = left + 'px'
          panel.style.top = 'auto'
          panel.style.right = 'auto'
          panel.style.bottom = (window.innerHeight - r.top + 8) + 'px'
        }
      }

      function statusDot(entry) {
        return entry.connected ? 'ok' : entry.enabled ? 'busy' : 'off'
      }
      function statusText(entry) {
        if (!entry.enabled) return '已断开'
        return entry.connected ? (entry.toolCount + ' 工具') : '已掉线'
      }

      function render() {
        const connected = state.entries.filter((e) => e.connected).length
        pillDot.className = 'dot ' + (connected > 0 ? 'ok' : state.entries.some((e) => e.enabled) ? 'busy' : 'off')
        pillText.textContent = 'MCP ' + connected + '/' + state.entries.length
        count.textContent = state.entries.length + ' 个'
        list.textContent = ''
        if (state.error) {
          const err = document.createElement('div')
          err.className = 'err'
          err.textContent = state.error
          list.append(err)
        }
        if (!state.entries.length) {
          const empty = document.createElement('div')
          empty.className = 'empty'
          empty.textContent = '未配置 MCP 服务器（cordis.patch.yml）'
          list.append(empty)
          return
        }
        for (const e of state.entries) {
          const entry = document.createElement('div')
          entry.className = 'entry'

          const row = document.createElement('div')
          row.className = 'row'
          const dot = document.createElement('span')
          dot.className = 'dot ' + statusDot(e)
          const srv = document.createElement('span')
          srv.className = 'srv'
          srv.textContent = e.serverName
          const meta = document.createElement('span')
          meta.className = 'meta'
          meta.textContent = (e.transport || '') + ' · ' + statusText(e)
          const btn = document.createElement('button')
          btn.className = 'btn'
          btn.textContent = e.enabled ? (e.connected ? '断开' : '重连') : '连接'
          btn.disabled = state.busyId === e.id
          btn.addEventListener('click', () => toggle(e, e.enabled && !e.connected))
          row.append(dot, srv, meta, btn)
          entry.append(row)

          if (e.connected && e.tools && e.tools.length) {
            const tools = document.createElement('div')
            tools.className = 'tools'
            for (const t of e.tools) {
              const chip = document.createElement('span')
              chip.className = 'tool'
              chip.textContent = t
              chip.title = t
              tools.append(chip)
            }
            entry.append(tools)
          }
          list.append(entry)
        }
      }

      async function refresh() {
        try {
          const res = await boundedFetch(API + '/status', { cache: 'no-store' })
          const data = await res.json()
          if (data && data.ok) {
            state.entries = data.entries || []
            state.error = null
            noteStatusData(data)
          } else {
            state.error = (data && data.error) || '状态获取失败'
          }
        } catch (err) {
          state.error = (err && err.name === 'AbortError')
            ? '状态获取超时'
            : String((err && err.message) || err)
        }
        render()
        // Re-arm with the interval matching the latest state. armPoll is a
        // no-op once disposed, so an in-flight refresh cannot revive the poll.
        armPoll(nextPollMs())
      }

      async function toggle(entry, restart) {
        state.busyId = entry.id
        state.error = null
        render()
        try {
          const body = restart
            ? { id: entry.id, enabled: true, restart: true }
            : { id: entry.id, enabled: !entry.enabled }
          const res = await boundedFetch(API + '/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json()
          if (!(data && data.ok)) state.error = (data && data.error) || '操作失败'
        } catch (err) {
          state.error = (err && err.name === 'AbortError')
            ? '操作超时'
            : String((err && err.message) || err)
        }
        state.busyId = null
        await refresh()
      }

      function onPillClick() {
        if (Date.now() - lastDragAt < 350) return // a drag just happened — not a click
        state.open = !state.open
        panel.classList.toggle('open', state.open)
        if (state.open) {
          placePanel()
          refresh()
        }
      }
      function onCloseClick() {
        state.open = false
        panel.classList.remove('open')
      }
      pill.addEventListener('click', onPillClick)
      track(function () { pill.removeEventListener('click', onPillClick) })
      closeBtn.addEventListener('click', onCloseClick)
      track(function () { closeBtn.removeEventListener('click', onCloseClick) })

      refresh()
      
      // Arm the poll once and register a single tracked cleanup: the closure
      // reads the live pollTimer binding, so dispose always clears the timer
      // that is currently armed, no matter how often it was re-armed.
      armPoll(POLL_INTERVALS.ACTIVE)
      track(function () {
        if (pollTimer !== null) clearInterval(pollTimer)
        pollTimer = null
        armedMs = null
      })

      // ── visibility gate: 设置 → 插件 → MCP Pill「显示状态胶囊」 ────────────
      // Default OFF: the root is created display:none and only the polled
      // /status payload (hot host mirror of pill.enabled) may reveal it.
      // Placed after every binding above is initialized because
      // applyVisibility() can call schedulePlace().
      let pillVisible = false

      function applyVisibility() {
        if (!root) return
        root.style.display = pillVisible ? '' : 'none'
        if (!pillVisible) {
          if (panel.classList.contains('open')) panel.classList.remove('open')
        } else {
          schedulePlace() // cluster rect was 0 while hidden — reposition now
        }
      }

      function noteStatusData(data) {
        const show = !!(data && data.pill && data.pill.enabled === true)
        if (show === pillVisible) return
        pillVisible = show
        applyVisibility()
      }

      if (scope && typeof scope.subscribe === 'function') {
        // A settings save reaches the host mirror immediately; re-fetch right
        // away so the pill flips without waiting for the next poll. The
        // dynamic poll below remains the safety net (and covers other tabs).
        const unsubscribe = scope.subscribe(function () { refresh() })
        track(function () { unsubscribe() })
      }

      // Mount immediately when the seat already exists; otherwise the document
      // observer mounts the pill as soon as [data-composer-seat] appears.
      ensureMounted()
      place()

      function disposePill() {
        if (disposed) return
        disposed = true
        pillMounted = false
        for (const controller of inFlight) {
          try { controller.abort() } catch (_) {}
        }
        inFlight.clear()
        if (rafPending && rafId !== 0) cancelAnimationFrame(rafId)
        rafPending = false
        rafId = 0
        if (dragCleanup) {
          const cleanupDrag = dragCleanup
          dragCleanup = null
          cleanupDrag()
        }
        for (let i = cleanups.length - 1; i >= 0; i--) {
          try { cleanups[i]() } catch (_) {}
        }
        cleanups.length = 0
        if (root && root.parentNode) root.parentNode.removeChild(root)
        root = null
        pillDispose = null
      }
      pillDispose = disposePill
      return disposePill
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return

      // Settings card first: pill mounting waits for the composer seat
      // asynchronously and must never delay or break the Settings Slot.
      const scope = ctx.settingsScope.bind({ namespace: NS })
      // DSH 0.1.2+ exposes fine-grained remote settings through
      // @deepseek-ai/dsh-api-remotes (ctx.remote). The legacy RC connection API
      // is no longer available, so there is no fallback branch.
      const remote = ctx.get('remote')
      const api = remote && remote.settings
        ? { settings: { mutate: (payload) => remote.settings.mutate(payload.ns, payload.ops, payload.expectedRevision).then((result) => ({ result })) } }
        : undefined
      const disposeSlot = ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        label: 'MCP Pill',
      }, function McpPillCard() {
        return e(SettingsCard, { scope, api })
      }))

      // Pill: fully lifecycle-owned as before, but created hidden — the gate
      // inside startPill reveals it only while /status reports pill.enabled
      // === true (default off).
      ctx.effect(() => startPill(scope), 'dsh-mcp-pill: composer pill')

      // Plugin-card style tag: created lazily by SettingsCard renders and
      // removed here so no style is left behind after stop / update.
      ctx.effect(() => () => removeCardStyles(), 'dsh-mcp-pill: plugin card style')

      return disposeSlot
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope', 'remote', 'remote.settings']
    return module.exports
  },
})