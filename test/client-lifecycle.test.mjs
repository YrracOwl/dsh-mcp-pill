import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── bundle evaluation helpers (real exports, real components) ───────────────
//
// The bundle is a browser artifact, but it needs no DOM to LOAD: constructing
// it only calls __ModuleLoader__.load and require('react'), and `apply` bails
// out on a document-less host. Evaluating it here gives the real `exports`
// (inject gate, ROW_CONFIG_KEY) and the real row-config component, which is
// stronger than matching source text.
function loadClientPlugin() {
  let spec = null
  const sandbox = {
    // `apply` returns early unless `document` exists; nothing in the SlotRegistrar
    // path this test drives touches the DOM beyond that probe.
    document: {},
    window: { __ModuleLoader__: { load(captured) { spec = captured } } },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  assert.ok(spec && typeof spec.factory === 'function', 'bundle must call window.__ModuleLoader__.load({ factory })')
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const plugin = spec.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require(' + id + ')')
  })
  return { plugin, react }
}

// One host shape: which optional services and which Slots are declared. `inject`
// fires only when every requested name is provided, exactly like cordis.
function makeCtx({ services = [], slots = [] } = {}) {
  const registered = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: {}, base: {}, user: {}, revision: 1 }),
    subscribe: () => () => {},
  }
  const ctx = {
    get(name) {
      if (name === 'settingsScope' && services.includes('settingsScope')) return { bind: () => scope }
      if (name === 'configForms' && services.includes('configForms')) return { get: () => scope }
      return undefined
    },
    inject(names, cb) {
      const list = Array.isArray(names) ? names : [names]
      if (list.every((name) => name === 'slots' || services.includes(name))) cb(ctx)
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(slot, cb) {
        if (!slots.includes(slot)) return () => {}
        const dispose = cb()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

// The key the official plugin-manager looks up: rowConfigKey(pkg.name, row.rowId)
// = `<package.json#name>#<the row id this package's own cordis.patch.yml declares>`.
function declaredRowConfigKey() {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rowId = patch.match(/^\s*-\s*id:\s*(\S+)\s*$/m)
  assert.ok(rowId, 'cordis.patch.yml must declare the bundle row id')
  return `${manifest.name}#${rowId[1]}`
}

// ── pill mounting: seat-only, waits, no off-page floating pill ──────────────

test('pill mounts only under the composer seat and waits for it', () => {
  assert.match(source, /ctx\.effect\(\(\) => startPill\(\(\) => scope\), 'dsh-mcp-pill: composer pill'\)/)
  assert.match(source, /function findSeat\(\)/)
  assert.match(source, /document\.querySelector\('\[data-composer-seat\]'\)/)
  assert.match(source, /function ensureMounted\(\)/)
  assert.match(source, /if \(!seat\) return false/)
  assert.match(source, /seat\.appendChild\(root\)/)
  assert.match(source, /domObserver\.observe\(document\.documentElement/)
  assert.match(source, /if \(ensureMounted\(\)\) schedulePlace\(\)/)
  assert.match(source, /if \(dragging \|\| !root\.isConnected\) return/)
})

// ── settings card + default-off visibility gate ──────────────────────────────

test('registers an official-style settings card under settings.plugin.item', () => {
  // 卡片必须在设置传输的子上下文上注册（sctx.slots），否则「设置 → 插件」页的账本
  // 在自己的上下文里读 ctx.slots.entries(...) 会拿到空数组，卡片永远不渲染。
  assert.match(source, /sctx\.slots\.inject\('settings\.plugin\.item'/)
  assert.match(source, /key: NS/)
  assert.match(source, /label: 'MCP Pill'/)
  assert.match(source, /function SettingsCard/)
  assert.match(source, /e\('li'/)
  assert.match(source, /api\.settings\.mutate/)
  assert.match(source, /expectedRevision/)
  assert.match(source, /\{ path: \['pill', 'enabled'\], kind: 'bool', label: '显示状态胶囊'/)
  assert.match(source, /默认关闭/)
  // NEITHER settings transport may appear in exports.inject: cordis treats every
  // inject name as a REQUIRED gate (Fiber._refresh() deactivates the fiber when one
  // has no provider), so declaring the optional transport leaves the plugin
  // permanently pending and fails Web boot ("waiting for service: configForms").
  // The optional wait lives in apply as ctx.inject([...], cb).
  assert.match(source, /exports\.inject = \['slots', 'remote', 'remote\.settings'\]/)
  assert.match(source, /function resolveSettingsScopeFrom\(ctx, namespace\)/)
  assert.match(source, /ctx\.inject\(\['settingsScope'\], registerCard\)/)
  assert.match(source, /ctx\.inject\(\['configForms'\], \(sctx\) => \{ if \(scope === undefined\) registerCard\(sctx\) \}\)/)
  assert.doesNotMatch(source, /exports\.inject = \[[^\]]*settingsScope/)
  assert.doesNotMatch(source, /exports\.inject = \[[^\]]*configForms/)
  assert.doesNotMatch(source, /ctx\.settingsScope\.bind/)
  assert.doesNotMatch(source, /exports\.inject = \['slots', 'settingsScope', 'connection'\]/)
  assert.doesNotMatch(source, /ctx\.get\('connection'\)/)
})

test('card style tag is lifecycle-owned', () => {
  assert.match(source, /function ensureCardStyles/)
  assert.match(source, /function removeCardStyles/)
  assert.match(source, /ctx\.effect\(\(\) => \(\) => removeCardStyles\(\), 'dsh-mcp-pill: plugin card style'\)/)
})

test('pill is created hidden and gated on the status payload', () => {
  assert.match(source, /display:none/)
  assert.match(source, /let pillVisible = false/)
  assert.match(source, /function applyVisibility\(\)/)
  assert.match(source, /function noteStatusData\(data\)/)
  assert.match(source, /data\.pill\.enabled === true/)
  assert.match(source, /noteStatusData\(data\)/)
  assert.match(source, /root\.style\.display = pillVisible \? '' : 'none'/)
})

test('settings save re-fetches status instantly and the subscription is disposed', () => {
  assert.match(source, /scope\.subscribe\(function \(\) \{ refresh\(\) \}\)/)
  assert.match(source, /track\(function \(\) \{ unsubscribe\(\) \}\)/)
})

test('no document.body or composer-card-parent mount fallback', () => {
  assert.doesNotMatch(source, /return\s+document\.body/)
  assert.doesNotMatch(source, /card\.parentElement/)
  assert.doesNotMatch(source, /\bmountTarget\b/)
  assert.doesNotMatch(source, /DOMContentLoaded/)
})

test('stale window-global mounted flag is gone (lifecycle flag replaces it)', () => {
  assert.doesNotMatch(source, /__dshMcpPillMounted/)
})

// ── lifecycle: mounted flag, disposers, idempotent cleanup ──────────────────

test('mounted flag is lifecycle-bound: set on mount, reset on dispose', () => {
  assert.match(source, /let pillMounted = false/)
  assert.match(source, /pillMounted = true/)
  assert.match(source, /pillMounted = false/)
  assert.match(source, /function disposePill\(\)/)
  assert.match(source, /if \(disposed\) return/)
})

test('every pill resource has a disposer (observers, intervals, rAF, listeners)', () => {
  assert.match(source, /domObserver\.disconnect\(\)/)
  assert.match(source, /seatRo\.disconnect\(\)/)
  assert.match(source, /clearInterval\(seatTimer\)/)
  assert.match(source, /clearInterval\(pollTimer\)/)
  assert.match(source, /cancelAnimationFrame\(rafId\)/)
  assert.match(source, /window\.removeEventListener\('scroll'/)
  assert.match(source, /window\.removeEventListener\('resize'/)
  assert.match(source, /document\.removeEventListener\('pointermove', onMove\)/)
  assert.match(source, /document\.removeEventListener\('pointerup', onUp\)/)
  assert.match(source, /cluster\.removeEventListener\('pointerdown', onPointerDown\)/)
  assert.match(source, /pill\.removeEventListener\('click', onPillClick\)/)
  assert.match(source, /closeBtn\.removeEventListener\('click', onCloseClick\)/)
})

test('drag-midway disposal releases document listeners and restores selection style', () => {
  assert.match(source, /dragCleanup = function \(\)/)
  assert.match(source, /document\.body\.style\.userSelect = prevSelect/)
  assert.match(source, /const cleanupDrag = dragCleanup/)
  assert.match(source, /cleanupDrag\(\)/)
})

test('dispose removes the pill root (with its shadow DOM), idempotently', () => {
  assert.match(source, /attachShadow\(\{ mode: 'open' \}\)/)
  assert.match(source, /root\.parentNode\.removeChild\(root\)/)
  assert.match(source, /stale\.parentNode\.removeChild\(stale\)/)
})

// ── preserved behavior: stacking, storage, polling, interactions ────────────

test('pill keeps z-index 1, anchor storage key, and dynamic polling semantics', () => {
  assert.match(source, /z-index:1/)
  assert.match(source, /ANCHOR_KEY = 'dsh\.mcpPill\.anchor'/)
  assert.match(source, /ANCHORS = Object\.freeze\(\['tl', 'tr', 'bl', 'br'\]\)/)
  assert.match(source, /POLL_INTERVALS = Object\.freeze\(\{/)
  assert.match(source, /ACTIVE: 3000/)
  assert.match(source, /IDLE: 10000/)
  assert.match(source, /ERROR: 5000/)
  assert.match(source, /FETCH_TIMEOUT_MS = 10000/)
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /armPoll\(nextPollMs\(\)\)/)
  assert.match(source, /ENSURE_MS = 2000/)
  assert.match(source, /API = '\/api\/mcp-pill'/)
})

test('fetch timeout, dispose abort, and no-churn re-arm are covered by guards', () => {
  assert.match(source, /function boundedFetch\(/)
  assert.match(source, /inFlight\.add\(controller\)/)
  assert.match(source, /inFlight\.delete\(controller\)/)
  assert.match(source, /setTimeout\(function \(\) \{ controller\.abort\(\) \}/)
  assert.match(source, /clearTimeout\(timer\)/)
  assert.match(source, /err\.name === 'AbortError'/)
  assert.match(source, /'状态获取超时'/)
  assert.match(source, /'操作超时'/)
  assert.match(source, /for \(const controller of inFlight\)/)
  assert.match(source, /inFlight\.clear\(\)/)
  assert.match(source, /if \(ms === armedMs && pollTimer !== null\) return/)
})

test('legacy anchor values and interaction semantics are preserved', () => {
  assert.match(source, /if \(saved === 'left'\) anchor = 'bl'/)
  assert.match(source, /if \(saved === 'right'\) anchor = 'br'/)
  assert.match(source, /Date\.now\(\) - lastDragAt < 350/)
  assert.match(source, /restart: true/)
  assert.match(source, /panel\.classList\.toggle\('open', state\.open\)/)
  assert.match(source, /placePanel\(\)/)
})

// ── the 0.1.7-rc.2 seat: the keyed slot plugins.row.config ──────────────────
//
// rc.2 REMOVED settings.plugin.item, so a card left only there renders nowhere
// and reports nothing. A bundle row's configuration seat is the keyed slot
// `plugins.row.config`, declared by the official plugin-manager page, and that
// page shows a row's configure control only while its registration ledger holds
// the exact `<package name>#<row id>` key. Both seats are registered, because
// each fires only where its own slot is declared.

test('rc.2: the card also registers on the keyed plugins.row.config seat', () => {
  assert.match(source, /sctx\.slots\.inject\('plugins\.row\.config', \(\) => sctx\.slots\.register\(\{/)
  assert.match(source, /name: 'plugins\.row\.config'/)
  assert.match(source, /key: ROW_CONFIG_KEY/)
  // the wait on `slots` is NON-GATING, and the legacy seat is untouched
  assert.match(source, /ctx\.inject\(\['slots'\], registerRowConfig\)/)
  assert.match(source, /sctx\.slots\.inject\('settings\.plugin\.item'/)
  // summary renders a one-liner, not the form
  assert.match(source, /props\.view === 'summary'/)
  assert.match(source, /dmpRowSummary/)
  // the optional, host-owned `form` prop is NOT a second read/write path
  assert.doesNotMatch(source, /props\.form/)
  assert.doesNotMatch(source, /\.form\b/)
})

test('rc.2: ROW_CONFIG_KEY is exactly `<package name>#<row id in cordis.patch.yml>`', () => {
  const expected = declaredRowConfigKey()
  // one literal in the source ...
  const literal = source.match(/const ROW_CONFIG_KEY = '([^']+)'/)
  assert.ok(literal, 'ROW_CONFIG_KEY must be declared as one single-quoted literal')
  assert.equal(literal[1], expected)
  // ... and the same value on the real exports the loader reads
  const { plugin } = loadClientPlugin()
  assert.equal(plugin.ROW_CONFIG_KEY, expected)
})

test('rc.2: the row-config occupant honours view=summary vs view=page', () => {
  const { plugin } = loadClientPlugin()
  const { ctx, registered } = makeCtx({ services: ['configForms'], slots: ['plugins.row.config'] })
  plugin.apply(ctx)
  // Only the rc.2 seat is declared here, exactly like a live rc.2 host: the
  // legacy settings.plugin.item registration must not fire, and the row seat
  // must receive our occupant under the ledger key.
  assert.deepEqual(registered.map((item) => item.options.name), ['plugins.row.config'])
  const entry = registered[0]
  assert.equal(entry.options.key, plugin.ROW_CONFIG_KEY)

  const summary = entry.component({ view: 'summary' })
  assert.equal(summary.type, 'span')
  assert.equal(summary.props.className, 'dmpRowSummary')
  // a one-liner only: a single text child, no elements and therefore no controls
  assert.ok(summary.children.every((child) => typeof child === 'string'))
  assert.match(summary.children.join(''), /显示状态胶囊/)

  const page = entry.component({ view: 'page' })
  assert.notEqual(page.type, 'span')
  assert.equal(typeof page.type, 'function')
  // the optional `form` prop changes nothing: values still flow through the one
  // resolved transport, so the page branch is the existing card either way
  const pageWithForm = entry.component({ view: 'page', form: { state: {}, mutate() {} } })
  assert.equal(pageWithForm.type, page.type)
  assert.equal(pageWithForm.props.scope, page.props.scope)
})

test('legacy 0.1.5 seat still registers on its own host shape', () => {
  const { plugin } = loadClientPlugin()
  const { ctx, registered } = makeCtx({ services: ['settingsScope'], slots: ['settings.plugin.item'] })
  plugin.apply(ctx)
  assert.deepEqual(
    registered.map((item) => `${item.options.name}#${item.options.key}`),
    ['settings.plugin.item#mcp-pill'],
  )
})

test('exports.inject hard-gates on no version-dependent settings service', () => {
  // cordis treats EVERY inject name as a REQUIRED gate (Fiber._refresh() marks
  // the fiber INACTIVE when one name has no provider), so naming the optional
  // settings transport here fails the whole Web boot with
  // "N entries did not activate / waiting for service: <name>". `slots` is
  // deliberately NOT in the forbidden set: it is the core client slot service
  // every Web host provides and it is what orders the registrations above after
  // the slot registry exists — it is not version-dependent. The gate list must
  // nonetheless stay exactly as it was: any ADDED name fails here.
  const { plugin } = loadClientPlugin()
  const inject = Array.from(plugin.inject)
  assert.ok(Array.isArray(plugin.inject), 'exports.inject must be an array')
  for (const name of ['settings', 'settingsScope', 'configForms']) {
    assert.ok(!inject.includes(name), `${name} must never be a hard inject gate`)
  }
  assert.deepEqual(inject, ['slots', 'remote', 'remote.settings'])
  // `remote.settings` is a service PATH, not the bare `settings` service
  assert.ok(inject.includes('remote.settings'))
})

// ── manifest: the schemastery FLOOR decides whether a settings page exists ───
//
// The profile root hoists the older 3.18.2 line, and `^3.18.1` is *satisfied*
// by that hoisted copy, so pnpm never materializes a private volatile-capable
// copy. `SettingsForms.describe()` drops any entry whose schema exposes no
// volatile field, so the settings page disappears with no error at all. This is
// a FLOOR rule, not a caret rule: the assertion below parses the declared range
// and compares its minimum version, so `>=3.18.4`, `^3.18.4` and any future
// higher floor pass while `^3.18.1` / `^3.18.2` / `^3.18.3` fail.
const VOLATILE_FLOOR = [3, 18, 4]

// Minimum stable version of a supported range, or null when the range is
// permissive / unparseable (a `*`-like range admits 3.18.2, so it is not a floor).
function minimumSatisfiableVersion(range) {
  if (typeof range !== 'string') return null
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'latest') return null
  if (trimmed.includes('||')) return null // an OR admits every branch's minimum
  let floor = null
  for (const token of trimmed.split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~|>=|<=|>|<|=|v)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(token)
    if (!m) return null
    const version = [Number(m[2]), Number(m[3]), Number(m[4])]
    const stable = m[5] === undefined
    const op = m[1] || '='
    // A caret/tilde/exact floor is the version itself; `>` sits just above it.
    const candidate = op === '>' ? [version[0], version[1], version[2] + 1] : version
    if (!stable) return null // a prerelease floor does not promise a stable `.volatile()`
    if (floor === null || compareVersions(candidate, floor) > 0) floor = candidate
  }
  return floor
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

test('declared @deepseek-ai/schemastery floor can never resolve a line without .volatile()', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // It must stay a private `dependencies` entry: a peer would be downgraded to
  // the profile's hoisted 3.18.2 copy, which is exactly the silent failure.
  assert.equal(
    Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, '@deepseek-ai/schemastery'),
    true,
    '@deepseek-ai/schemastery must stay a private dependencies entry',
  )
  const range = manifest.dependencies['@deepseek-ai/schemastery']
  const floor = minimumSatisfiableVersion(range)
  assert.ok(floor !== null, `unparseable / permissive schemastery range: ${range}`)
  assert.ok(
    compareVersions(floor, VOLATILE_FLOOR) >= 0,
    `the declared floor must exclude schemastery lines without .volatile() (got ${range}, floor ${floor.join('.')})`,
  )
})

test('the floor guard itself rejects the volatile-less lines and accepts higher floors', () => {
  for (const range of ['^3.18.4', '>=3.18.4', '^3.18.5', '>3.18.3', '3.18.4', '^4.0.0']) {
    const floor = minimumSatisfiableVersion(range)
    assert.ok(floor, `${range} must parse to a floor`)
    assert.ok(compareVersions(floor, VOLATILE_FLOOR) >= 0, `${range} must pass the floor guard`)
  }
  for (const range of ['^3.18.1', '^3.18.2', '^3.18.3', '>=3.18.0', '~3.18.2', '3.18.2', '*', '^3.18.4-rc.1']) {
    const floor = minimumSatisfiableVersion(range)
    assert.ok(
      floor === null || compareVersions(floor, VOLATILE_FLOOR) < 0,
      `${range} must fail the floor guard`,
    )
  }
})