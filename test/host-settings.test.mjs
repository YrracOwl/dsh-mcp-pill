import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { apply, SETTINGS_NS, DEFAULT_SETTINGS, validateSettings } from '../lib/index.js'

const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

// ── schemastery-line portability ────────────────────────────────────────────
//
// A schema-parsed value depends on which schemastery line is installed:
//   • < 3.18.4 (the ≤ 0.1.5 line): there is no `volatile()`, so a volatile field
//     parses to the PLAIN value;
//   • ≥ 3.18.4 (the 0.1.7 corridor): the field parses to a cosmokit cell that
//     exposes `get()` plus the registered write symbol below, and no `set`.
// Every assertion about a parsed Config goes through these helpers, so a single
// assertion holds on both lines instead of encoding whichever one is installed.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

const isVolatileCell = (value) =>
  value !== null && typeof value === 'object' && typeof value.get === 'function' && VOLATILE_WRITE in value

function readVolatile(value) {
  return isVolatileCell(value) ? value.get() : value
}

/** Recursively replace every volatile cell with the value it carries. */
function plainValue(value) {
  const unwrapped = readVolatile(value)
  if (Array.isArray(unwrapped)) return unwrapped.map(plainValue)
  if (unwrapped !== null && typeof unwrapped === 'object') {
    return Object.fromEntries(Object.entries(unwrapped).map(([key, child]) => [key, plainValue(child)]))
  }
  return unwrapped
}

/** Write a volatile-shaped field the way the settings service does: in place. */
function writeVolatileInPlace(holder, key, value) {
  if (isVolatileCell(holder[key])) {
    holder[key][VOLATILE_WRITE](value) // the cell's registered write marker
    return
  }
  holder[key] = value // the older line parses to the plain value
}

function makeCtx({ settings }) {
  const routes = {}
  const disposers = []
  const ctx = {
    baseUrl: new URL('file:///D:/fake-profile/'),
    // The declarative branch passes this as configure()'s owner.
    fiber: { owner: 'dsh-mcp-pill' },
    inject(deps, fn) {
      if (Array.isArray(deps) && deps.includes('settings') && settings) {
        fn({
          settings,
          effect(cb) {
            const disposer = typeof cb === 'function' ? cb() : undefined
            if (typeof disposer === 'function') disposers.push(disposer)
            return disposer
          },
        })
      }
    },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined },
    fs: {
      async resolve(p) { return p },
      async readText() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) },
    },
    tools: { schemas() { return [] } },
    webServer: {
      register(spec) { routes[spec.path] = spec; return () => {} },
    },
  }
  return { ctx, routes, disposers }
}

function fakeRes() {
  const res = {}
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers }
  res.end = (body) => { res.body = body }
  return res
}

async function readStatus(handler) {
  const res = fakeRes()
  await handler({}, res)
  return JSON.parse(res.body)
}

test('status reports pill.enabled false without the settings service', async () => {
  const { ctx, routes } = makeCtx({ settings: undefined })
  apply(ctx, {})
  assert.ok(routes['/api/mcp-pill/status'])
  const data = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.equal(data.ok, true)
  assert.deepEqual(data.pill, { enabled: false })
})

test('registers the mcp-pill namespace with default-off base and live applies', () => {
  const registered = []
  const { ctx } = makeCtx({
    settings: {
      register(ns, schema, opts) {
        registered.push({ ns, opts })
        return { get() { return DEFAULT_SETTINGS }, watch() { return () => {} } }
      },
    },
  })
  apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].ns, SETTINGS_NS)
  assert.equal(SETTINGS_NS, 'mcp-pill')
  assert.equal(registered[0].opts.applies, 'live')
  assert.equal(registered[0].opts.base.pill.enabled, false)
})

test('status mirrors the resolved pill.enabled value', async () => {
  let value = DEFAULT_SETTINGS
  let watchCb = null
  const { ctx, routes } = makeCtx({
    settings: {
      register() {
        return {
          get() { return value },
          watch(cb) { watchCb = cb; return () => {} },
        }
      },
    },
  })
  apply(ctx, {})
  const on = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.deepEqual(on.pill, { enabled: false }) // default stays hidden
  value = { pill: { enabled: true } }
  watchCb() // the real scope fires this on every settings change
  const enabled = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.deepEqual(enabled.pill, { enabled: true })
})

test('register validate wrapper throws on invalid settings', () => {
  let validate
  const { ctx } = makeCtx({
    settings: {
      register(ns, schema, opts) { validate = opts.validate; return { get() { return DEFAULT_SETTINGS }, watch() { return () => {} } } },
    },
  })
  apply(ctx, {})
  assert.throws(() => validate({ pill: { enabled: 'yes' } }), /boolean/)
  assert.throws(() => validate({ bogus: true }), /unknown top-level key/)
  assert.throws(() => validate({ pill: { bogus: true } }), /unknown pill key/)
  assert.doesNotThrow(() => validate({}))
  assert.doesNotThrow(() => validate({ pill: { enabled: true } }))
})

test('0.1.7+ host: no register() on the settings service is tolerated, not thrown', async () => {
  // DSH 0.1.7-rc.1 removes ctx.settings.register entirely: the namespace becomes
  // a form derived from the profile entry's Config schema. The host half must
  // branch instead of calling a missing method, and the routes must still serve.
  const { ctx, routes } = makeCtx({ settings: {} })
  apply(ctx, {})
  assert.ok(routes['/api/mcp-pill/status'])
  const data = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.equal(data.ok, true)
  // Default-off is preserved on the newer host too.
  assert.deepEqual(data.pill, { enabled: false })
})

// ── declarative host (0.1.7-rc.1+): Config-owned namespace ──────────────────

test('declarative host: configure({ auto: false }) is effect-owned and called once', () => {
  const calls = []
  let disposed = 0
  const { ctx, disposers } = makeCtx({
    settings: {
      configure(presentation, owner) {
        calls.push({ presentation, owner })
        return () => { disposed++ }
      },
    },
  })
  apply(ctx, {})
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].presentation, { auto: false })
  assert.equal(calls[0].owner, ctx.fiber, 'configure() must own the plugin fiber')
  // The registration went through sctx.effect, so it is disposed with the fiber.
  assert.equal(disposers.length, 1)
  assert.equal(disposed, 0)
  disposers[0]()
  assert.equal(disposed, 1)
})

test('declarative host: a configure() throw is swallowed, never fatal', () => {
  // configure() throws when called twice for the same fiber; the namespace still
  // comes from Config, so the plugin must keep working.
  const { ctx, routes } = makeCtx({
    settings: { configure() { throw new Error('already configured') } },
  })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.ok(routes['/api/mcp-pill/status'])
})

test('declarative host: pill.enabled is read on demand from the entry config', async () => {
  const WRITE = Symbol.for('cosmokit.volatile.write')
  let enabled = false
  // A cosmokit volatile cell: get() plus the registered write symbol, and no
  // `set` — which is exactly why the reader must key on the symbol.
  const cell = {
    get() { return enabled },
    [WRITE](next) { enabled = next },
  }
  const { ctx, routes } = makeCtx({ settings: { configure() { return () => {} } } })
  apply(ctx, { patchFile: 'cordis.patch.yml', pill: { enabled: cell } })

  const off = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.deepEqual(off.pill, { enabled: false })

  // An in-place write (no remount, no watch callback, no cached value): the very
  // next read must observe it. A cached apply-time value would stay false here.
  cell[WRITE](true)
  const on = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.deepEqual(on.pill, { enabled: true })

  cell[WRITE](false)
  const back = await readStatus(routes['/api/mcp-pill/status'].handler)
  assert.deepEqual(back.pill, { enabled: false })
})

test('declarative host: the REAL parsed Config drives /status on either line', async () => {
  // Not a hand-built cell: this is what the installed schemastery actually
  // produces for `{}` — a cosmokit cell on ≥ 3.18.4, a plain `false` below it.
  const mod = await import('../lib/index.js')
  const parsed = mod.default.Config['~standard'].validate({ patchFile: 'cordis.patch.yml' }).value
  const { ctx, routes } = makeCtx({ settings: { configure() { return () => {} } } })
  apply(ctx, parsed)

  assert.deepEqual((await readStatus(routes['/api/mcp-pill/status'].handler)).pill, { enabled: false })

  // Flip the field in place the way the settings service does — through the
  // cell's write marker on 3.18.4+, by assignment on the older line. No remount,
  // no watch callback: the next /status read must see it, and the payload must
  // stay a plain boolean rather than leaking the wrapper onto the wire.
  writeVolatileInPlace(parsed.pill, 'enabled', true)
  assert.equal(readVolatile(parsed.pill.enabled), true)
  assert.deepEqual((await readStatus(routes['/api/mcp-pill/status'].handler)).pill, { enabled: true })

  writeVolatileInPlace(parsed.pill, 'enabled', false)
  assert.deepEqual((await readStatus(routes['/api/mcp-pill/status'].handler)).pill, { enabled: false })
})

test('declarative host: plain, absent and wrongly typed values never throw', async () => {
  const caseOf = async (config) => {
    const { ctx, routes } = makeCtx({ settings: { configure() { return () => {} } } })
    apply(ctx, config)
    return (await readStatus(routes['/api/mcp-pill/status'].handler)).pill
  }

  assert.deepEqual(await caseOf({ pill: { enabled: true } }), { enabled: true })
  assert.deepEqual(await caseOf({}), { enabled: false })
  assert.deepEqual(await caseOf({ pill: { enabled: 'yes' } }), { enabled: false })

  // The reader keys on Symbol.for('cosmokit.volatile.write'), NOT on a `set`
  // method (which a real volatile cell does not have). An object that merely
  // exposes get+set is not a cell and must be passed through untouched, so this
  // stays default-off. Keying on `set` would have read it as `true`.
  const impostor = { get() { return true }, set() { return true } }
  assert.deepEqual(await caseOf({ pill: { enabled: impostor } }), { enabled: false })

  // …while the real cell shape — get() plus the registered write symbol, no
  // `set` — IS unwrapped.
  const cell = { get() { return true }, [VOLATILE_WRITE]() {} }
  assert.deepEqual(await caseOf({ pill: { enabled: cell } }), { enabled: true })
})

test('legacy host: the declarative configure() call is never reached', () => {
  let configured = 0
  const { ctx } = makeCtx({
    settings: {
      register() { return { get() { return DEFAULT_SETTINGS }, watch() { return () => {} } } },
      configure() { configured++; return () => {} },
    },
  })
  apply(ctx, {})
  assert.equal(configured, 0)
})

// ── source guards: the version-portable host contract ───────────────────────

test('host declares the entry Config on its default export', async () => {
  // cordis reads the plugin's schema as `runtime.Config` (Registry.plugin) off
  // the unwrapped export; for an object plugin that is this `Config` property,
  // the equivalent of a class's `static Config`. It is the declarative host's
  // settings namespace, keyed by the loader entry id (`mcp-pill`).
  assert.match(source, /export default \{ name, inject, Config, apply \}/)
  assert.match(source, /patchFile: Schema\.string\(\)\.default\('cordis\.patch\.yml'\)/)
  assert.match(source, /enabled: volatile\(Schema\.boolean\(\)\.default\(DEFAULT_SETTINGS\.pill\.enabled\)\)/)

  const mod = await import('../lib/index.js')
  assert.ok(mod.default, 'the plugin must have a default export')
  const schema = mod.default.Config
  assert.ok(schema, 'the default export must carry the entry Config schema')
  assert.equal(typeof schema['~standard'].validate, 'function', 'Config must be a schema object')
  assert.equal(typeof schema.toJSON, 'function')

  const result = schema['~standard'].validate({ patchFile: 'p.yml' })
  assert.equal(result.issues, undefined)
  // Unwrapped, so the same assertions hold whether this line parses the volatile
  // leaf to a plain value (< 3.18.4) or to a cosmokit cell (≥ 3.18.4).
  const parsed = plainValue(result.value)
  assert.equal(parsed.patchFile, 'p.yml')
  assert.equal(parsed.pill.enabled, DEFAULT_SETTINGS.pill.enabled)
  assert.deepEqual(parsed.pill, { enabled: false })
  assert.equal(mod.default.name, 'dsh-mcp-pill')
  assert.deepEqual(mod.default.inject, ['webServer', 'fs', 'tools'])
})

test('the volatile helpers are shape-agnostic (plain value and cosmokit cell)', () => {
  // Plain shape: the ≤ 0.1.5 line returns the value untouched.
  assert.equal(readVolatile(false), false)
  assert.equal(readVolatile(true), true)
  assert.equal(readVolatile('p.yml'), 'p.yml')
  assert.equal(readVolatile(undefined), undefined)
  const plain = { enabled: false }
  assert.equal(readVolatile(plain), plain)
  assert.deepEqual(plainValue({ pill: { enabled: false } }), { pill: { enabled: false } })

  // Cell shape: get() plus the registered write symbol, and no `set`.
  const makeCell = (initial) => {
    let stored = initial
    return { get: () => stored, [VOLATILE_WRITE]: (next) => { stored = next } }
  }
  const cell = makeCell(false)
  assert.equal(readVolatile(cell), false)
  assert.deepEqual(plainValue({ pill: { enabled: cell } }), { pill: { enabled: false } })

  // Writing goes through the marker on the cell shape and by assignment on the
  // plain shape; either way the read afterwards sees the new value.
  const cellHolder = { enabled: makeCell(false) }
  writeVolatileInPlace(cellHolder, 'enabled', true)
  assert.equal(readVolatile(cellHolder.enabled), true)
  const plainHolder = { enabled: false }
  writeVolatileInPlace(plainHolder, 'enabled', true)
  assert.equal(plainHolder.enabled, true)

  // An object that merely looks similar (get + set, no marker) is not a cell.
  const impostor = { get: () => false, set: () => {} }
  assert.equal(readVolatile(impostor), impostor)
  assert.equal(isVolatileCell(impostor), false)

  // Therefore an assertion written through these helpers cannot depend on which
  // of the two shapes the installed schemastery produced.
  const plainShape = { pill: { enabled: false } }
  const cellShape = { pill: { enabled: makeCell(false) } }
  assert.deepEqual(plainValue(plainShape), plainValue(cellShape))
})

test('volatile is applied capability-detected, never unconditionally', () => {
  // The 0.1.5 line (schemastery 3.18.1/3.18.2) has no `volatile`, so a literal
  // call would throw at import time on that host.
  assert.match(source, /typeof schema\?\.volatile === 'function'\s*\?\s*schema\.volatile\(\)/)
  assert.match(source, /const Config = Schema\.object\(/)
  // Exactly one `.volatile()` call site in the whole file: the guarded helper.
  assert.equal((source.match(/\.volatile\(\)/g) || []).length, 1)
  assert.doesNotMatch(source, /Schema\.boolean\(\)\.default\([^)]*\)\.volatile\(\)/)
})

test('the settings service is never a hard inject gate', () => {
  const declared = source.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(declared, 'the host must declare its inject list')
  assert.doesNotMatch(declared[1], /settings/)
  assert.deepEqual(declared[1].split(',').map((s) => s.trim()), ["'webServer'", "'fs'", "'tools'"])
  // The optional transport stays behind the non-gating ctx.inject([...]) wait.
  assert.match(source, /ctx\.inject\(\['settings'\], \(sctx\) => \{/)
  assert.doesNotMatch(source, /exports\.inject = \[[^\]]*settings/)
})

test('declarative branch calls configure with auto:false and the plugin fiber', () => {
  // Effect-wrapped (disposed with the fiber), guarded by a typeof probe because
  // configure() does not exist on ≤ 0.1.5, and owned by this plugin's fiber.
  assert.match(source, /sctx\.effect\(\(\) => settingsApi\.configure\(\{ auto: false \}, ctx\.fiber\)/)
  assert.match(source, /if \(typeof settingsApi\.configure !== 'function'\) return/)
  // Read on demand through the volatile reader — never cached at apply time.
  assert.match(source, /function readVolatile\(value\)/)
  assert.match(source, /Symbol\.for\('cosmokit\.volatile\.write'\)/)
  assert.match(source, /declarativeSettings \? readEntryPillEnabled\(\) : pillState\.enabled/)
  assert.match(source, /pill: \{ enabled: pillEnabled\(\) \}/)
  assert.doesNotMatch(source, /pill: \{ enabled: pillState\.enabled \}/)
})

test('validateSettings returns { ok, errors } and falls back to defaults', () => {
  const bad = validateSettings({ pill: { enabled: 'yes' } })
  assert.equal(bad.ok, false)
  assert.match((bad.errors || []).join(' '), /boolean/)

  const unknown = validateSettings({ bogus: true, pill: { enabled: true } })
  assert.equal(unknown.ok, false)
  assert.match((unknown.errors || []).join(' '), /unknown top-level key/)

  const nested = validateSettings({ pill: { bogus: true } })
  assert.equal(nested.ok, false)
  assert.match((nested.errors || []).join(' '), /unknown pill key/)

  const empty = validateSettings({})
  assert.equal(empty.ok, true)
  assert.equal(empty.config.pill.enabled, false)

  const good = validateSettings({ pill: { enabled: true } })
  assert.equal(good.ok, true)
  assert.equal(good.config.pill.enabled, true)
})
