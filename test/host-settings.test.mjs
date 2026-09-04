import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, SETTINGS_NS, DEFAULT_SETTINGS, validateSettings } from '../lib/index.js'

function makeCtx({ settings }) {
  const routes = {}
  const ctx = {
    baseUrl: new URL('file:///D:/fake-profile/'),
    inject(deps, fn) {
      if (Array.isArray(deps) && deps.includes('settings') && settings) {
        fn({
          settings,
          effect(cb) { return typeof cb === 'function' ? cb() : undefined },
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
  return { ctx, routes }
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
