// dsh-mcp-pill — host half (official bundle form)
//
// Serves the JSON RPC for the client half:
//   GET  /api/mcp-pill/status  -> JSON status of every configured MCP connection
//                                 plus `pill.enabled` (the visibility toggle)
//   POST /api/mcp-pill/set     -> { id, enabled } toggles a connection via the
//                                 patch file's `disabled` marker (loader HMR applies it)
//
// The visibility of the pill itself is owned by the official settings service:
// on ≤ 0.1.5 this half registers the `mcp-pill` namespace
// ({ pill: { enabled: false } }); on ≥ 0.1.7 the namespace is this entry's own
// `Config` (same shape, with the leaf marked volatile). Either way the effective
// value is read on demand and mirrored into every /status response, so the
// client half can follow it with its existing poll loop. Default is OFF.
//
// The client half (lib/client.js) is a __ModuleLoader__ web bundle — no
// tapIndex, no page-level <script> injection.
//
// Config (from the mounting row):
//   patchFile  -> the cordis.patch.yml to parse MCP entries from.
//                 Default: <profile>/cordis.patch.yml.
//
// Resolution: the web process's cwd is NOT the profile directory — it is the
// shell it was launched from (often the home dir). The authoritative anchor
// is ctx.baseUrl (the profile dir, set by the boot include), so relative
// patchFile values resolve against it first, falling back to process.cwd()
// for standalone boots that load this plugin outside a profile.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import {
  SETTINGS_NS,
  DEFAULT_SETTINGS,
  isPlainObject,
  cloneSettings,
  validateSettings,
} from './config.js'

export const name = 'dsh-mcp-pill'
export const inject = ['webServer', 'fs', 'tools']

const MCP_NAME = '@deepseek-ai/dsh-mcp-client'

// ── settings portability helpers ────────────────────────────────────────────
//
// `Schema.prototype.volatile` exists only from @deepseek-ai/schemastery 3.18.4
// (the DSH ≥ 0.1.7-rc.1 corridor). The 0.1.5 line resolves 3.18.1/3.18.2, where
// that method is undefined and calling it throws, so the two hosts cannot share
// one literal schema expression: the marker is applied through this probe and
// degrades to the plain schema where the method is absent.
const volatile = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)

// A volatile field's parsed value is a cosmokit cell, not the value itself: it
// exposes `get()` plus the registered write symbol below and NOTHING else — no
// `set`. Keying on that symbol (rather than on a `set` method that never exists,
// or on importing cosmokit, which would add a dependency for nothing) is what
// makes the read yield the real value. The settings service writes such a field
// in place without remounting the entry, so the value must be read on demand.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function readVolatile(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get !== 'function') return value
  if (!(VOLATILE_WRITE in value)) return value
  return value.get()
}

// ── the loader entry's own Config (DSH ≥ 0.1.7-rc.1) ────────────────────────
//
// The declarative host has no `ctx.settings.register(namespace, schema, opts)`:
// a settings namespace exists only as the ACTIVE entry's own Config schema,
// keyed by the loader entry id (`mcp-pill` — see cordis.patch.yml), and only
// fields marked volatile produce an editable form (an entry whose schema
// contains none gets no form at all). The nesting and defaults are kept
// identical to the legacy `mcp-pill` namespace so the client half reads the same
// `pill.enabled` on both hosts; `patchFile` stays the row's own field. A
// volatile field must sit at a fixed object path and never enclose another
// volatile field, so only the leaf is marked.
const Config = Schema.object({
  patchFile: Schema.string().default('cordis.patch.yml'),
  pill: Schema.object({
    enabled: volatile(Schema.boolean().default(DEFAULT_SETTINGS.pill.enabled)),
  }).default(cloneSettings(DEFAULT_SETTINGS.pill)),
})

function resolvePatchFile(ctx, config) {
  const rel = (config && config.patchFile) ? String(config.patchFile) : 'cordis.patch.yml'
  if (path.isAbsolute(rel)) return rel
  try {
    if (ctx && ctx.baseUrl) return fileURLToPath(new URL(rel, ctx.baseUrl))
  } catch (_) { /* not a URL — fall through to cwd */ }
  return path.resolve(process.cwd(), rel)
}

function parseEntries(text) {
  const entries = []
  const topBlocks = text.split(/\n(?=- )/)
  for (const top of topBlocks) {
    const rows = top.split(/\n(?= {4}- )/)
    for (const row of rows) {
      if (!row.includes(MCP_NAME)) continue
      const idMatch = row.match(/(?:^|\n)\s*- id:\s*([^\s]+)/)
      const serverName = (row.match(/serverName:\s*([^\s]+)/) || [])[1]
      const transport = (row.match(/transport:\s*([^\s]+)/) || [])[1]
      const disabled = /disabled:\s*true/.test(row)
      if (idMatch) entries.push({ id: idMatch[1], serverName, transport, disabled })
    }
  }
  return entries
}

function setEntryDisabled(text, id, disabled) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return { ok: false, error: '非法条目 id' }
  }
  // 全行锚定：- id: <id> 独占一行，避免前缀碰撞（如 id=mcp 误中 mcp-deveco）
  const re = new RegExp('(^|\\n)\\s*- id:\\s*' + id + '\\s*(\\n|$)')
  const m = re.exec(text)
  if (!m) return { ok: false, error: 'patch 文件中未找到条目 ' + id }
  const start = m.index + m[0].indexOf('- id:')
  const lineStart = text.lastIndexOf('\n', start) + 1
  const lineEnd = text.indexOf('\n', start)
  const rest = text.slice(lineEnd + 1)
  const nextRow = rest.search(/\n {4}- |\n- /)
  const blockEnd = nextRow < 0 ? text.length : lineEnd + 1 + nextRow
  const block = text.slice(lineStart, blockEnd)
  if (!block.includes(MCP_NAME)) return { ok: false, error: '条目 ' + id + ' 不是 dsh-mcp-client 条目' }
  if (disabled) {
    if (/disabled:\s*true/.test(block)) return { ok: true, changed: false }
    const insertAt = text.indexOf('\n', start) + 1
    return { ok: true, changed: true, next: text.slice(0, insertAt) + '      disabled: true\n' + text.slice(insertAt) }
  }
  const m2 = block.match(/\n[ \t]*disabled:\s*true/)
  if (!m2) return { ok: true, changed: false }
  const at = lineStart + m2.index
  return { ok: true, changed: true, next: text.slice(0, at) + text.slice(at + m2[0].length) }
}

export function apply(ctx, config) {
  const ws = ctx.webServer
  if (!ws) return

  const patchFile = resolvePatchFile(ctx, config)

  // Visibility toggle state, mirrored from the official settings service.
  // Defaults to hidden; the client follows /status, so no direct coupling.
  const pillState = { enabled: false }

  // True once the settings service is known to be the declarative host, where
  // the effective value lives in this entry's parsed Config instead of a scope.
  let declarativeSettings = false

  function readPillEnabled(scope) {
    try {
      const value = scope.get()
      return !!(isPlainObject(value) && isPlainObject(value.pill) && value.pill.enabled === true)
    } catch (_) {
      return false
    }
  }

  // Declarative host: the pill toggle is this entry's parsed Config, and the
  // settings service rewrites a volatile field IN PLACE without remounting the
  // entry — so the value must be read on demand from `config` and never cached
  // at apply time. Unwrapping both levels is harmless when neither is a cell.
  function readEntryPillEnabled() {
    try {
      const pill = readVolatile(config && config.pill)
      const enabled = readVolatile(pill && pill.enabled)
      return enabled === true
    } catch (_) {
      return false
    }
  }

  // Single source of truth for the routes: whichever host owns the value, an
  // in-place settings write is observed on the next /status read.
  function pillEnabled() {
    return declarativeSettings ? readEntryPillEnabled() : pillState.enabled
  }

  ctx.inject(['settings'], (sctx) => {
    // ── settings registration: dual-host ────────────────────────────────────
    //
    // ≤ 0.1.5  ctx.settings.register(namespace, schema, options) exists and this
    //          plugin owns its `mcp-pill` namespace exactly as before, mirroring
    //          the resolved `pill.enabled` into pillState for /status.
    // ≥ 0.1.7  register() is GONE. The namespace is not registered by the plugin
    //          at all: the settings service derives one form per ACTIVE profile
    //          entry from that entry's Config schema (keyed by the entry id) and
    //          exposes only fields marked volatile. The effective value therefore
    //          arrives through this entry's parsed `config`, which is read on
    //          demand by pillEnabled() so an in-place volatile write is seen
    //          without a remount. configure({ auto: false }) suppresses the
    //          official generic form page — the namespace still appears in the
    //          client mirror, so the plugin's own settings card keeps working.
    //
    // Nothing throws on either host, and with no settings service at all the
    // pill stays hidden (default off).
    const settingsApi = sctx.settings
    if (!settingsApi) return

    if (typeof settingsApi.register === 'function') {
      try {
        const schema = Schema.object({
          pill: Schema.object({
            enabled: Schema.boolean().default(DEFAULT_SETTINGS.pill.enabled),
          }).default(cloneSettings(DEFAULT_SETTINGS.pill)),
        })
        const scope = settingsApi.register(SETTINGS_NS, schema, {
          base: cloneSettings(DEFAULT_SETTINGS),
          applies: 'live',
          // The official settings service treats a throw as rejection and
          // discards the return value, so translate the { ok, errors } contract
          // into the throw contract here.
          validate: (value) => {
            const validated = validateSettings(value)
            if (!validated.ok) throw new Error((validated.errors || []).join('; '))
          },
        })
        pillState.enabled = readPillEnabled(scope)
        sctx.effect(() => scope.watch(() => {
          pillState.enabled = readPillEnabled(scope)
        }), 'dsh-mcp-pill: settings watch')
        sctx.effect(() => () => {
          pillState.enabled = false
        }, 'dsh-mcp-pill: settings fallback')
      } catch (_) {
        // Settings stay optional: without the service the pill remains hidden
        // (default off) and the MCP rows keep working through the patch file.
      }
      return
    }

    // Declarative host: no register() at all, so the namespace is this entry's
    // Config and every read goes through readEntryPillEnabled().
    declarativeSettings = true
    if (typeof settingsApi.configure !== 'function') return
    try {
      sctx.effect(() => settingsApi.configure({ auto: false }, ctx.fiber), 'dsh-mcp-pill: settings presentation')
    } catch (_) {
      // configure() throws when called twice for one fiber. The namespace is
      // still derived from Config, so failing to suppress the generated page is
      // never fatal.
    }
  })

  function json(res, code, data) {
    const body = JSON.stringify(data)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > 8192) throw Object.assign(new Error('request body too large'), { status: 413 })
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  // Loopback-only web server: allow same-origin browser POSTs (Origin matches
  // our own Host) and local tooling without an Origin header; reject foreign
  // Origins outright as CSRF protection.
  function originAllowed(req) {
    const origin = req.headers.origin
    if (!origin) return true // non-browser local caller (curl / MCP tooling)
    const host = req.headers.host || ''
    const base = /^https?:\/\/([^/]+)/i.exec(origin)
    if (!base) return false
    return base[1] === host
  }

  // DNS-rebinding fence: the web server only binds loopback, so a legitimate
  // request's Host header must name the loopback host. A rebinding attack
  // resolves an attacker domain to 127.0.0.1 and sends Host: attacker.com.
  function hostAllowed(req) {
    let host = (req.headers.host || '').split(':')[0].toLowerCase()
    host = host.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  }

  async function status() {
    let target, text
    try {
      target = await ctx.fs.resolve(patchFile)
      text = await ctx.fs.readText(target)
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (/not found|ENOENT|no such file/i.test(msg)) {
        // The patch file does not exist — nothing to report, not an error.
        return { ok: true, patchFile, warning: msg, pill: { enabled: pillEnabled() }, entries: [] }
      }
      throw err
    }
    const entries = parseEntries(text)
    const schemas = ctx.tools.schemas()
    const byServer = {}
    for (const s of schemas) {
      const m = /^mcp__([A-Za-z0-9_-]+)__/.exec(s.name || '')
      if (m) {
        if (!byServer[m[1]]) byServer[m[1]] = []
        byServer[m[1]].push(s.name)
      }
    }
    return {
      ok: true,
      patchFile,
      pill: { enabled: pillEnabled() },
      entries: entries.map((e) => ({
        id: e.id,
        serverName: e.serverName || e.id,
        transport: e.transport || 'unknown',
        enabled: !e.disabled,
        connected: !e.disabled && (byServer[e.serverName] || []).length > 0,
        toolCount: (byServer[e.serverName] || []).length,
        tools: (byServer[e.serverName] || []).slice(),
      })),
    }
  }

  ctx.effect(() => ws.register({
    kind: 'exact',
    path: '/api/mcp-pill/status',
    handler: async (req, res) => {
      try {
        json(res, 200, await status())
      } catch (err) {
        json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-mcp-pill: status route')

  ctx.effect(() => ws.register({
    kind: 'exact',
    path: '/api/mcp-pill/set',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required' })
      if (!hostAllowed(req)) return json(res, 403, { ok: false, error: 'host not allowed' })
      if (!originAllowed(req)) return json(res, 403, { ok: false, error: 'origin not allowed' })
      try {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch (err) {
          if (err && err.status === 413) return json(res, 413, { ok: false, error: 'request body too large' })
          return json(res, 400, { ok: false, error: 'invalid JSON body' })
        }
        const id = body && body.id
        const enabled = !!(body && body.enabled)
        const restart = !!(body && body.restart)
        if (!id) return json(res, 400, { ok: false, error: '缺少 id 参数' })
        const target = await ctx.fs.resolve(patchFile)
        const text = await ctx.fs.readText(target)
        if (restart) {
          // restart: 断开并立即重新挂载该连接（先置 disabled，再恢复）
          const off = setEntryDisabled(text, id, true)
          if (!off.ok) return json(res, 404, off)
          const offText = off.changed ? off.next : text
          if (off.changed) await ctx.fs.writeText(target, offText)
          await new Promise((r2) => setTimeout(r2, 150))
          const on = setEntryDisabled(offText, id, false)
          if (!on.ok) return json(res, 404, on)
          if (on.changed) await ctx.fs.writeText(target, on.next)
          return json(res, 200, { ok: true, id, enabled: true, changed: true, restarted: true })
        }
        const r = setEntryDisabled(text, id, !enabled)
        if (!r.ok) return json(res, 404, r)
        if (r.changed) await ctx.fs.writeText(target, r.next)
        json(res, 200, { ok: true, id, enabled, changed: !!r.changed })
      } catch (err) {
        json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-mcp-pill: set route')
}

// The plugin object handed to the loader. `Config` is read by cordis as
// `runtime.Config` (see Registry.plugin) — for an object plugin this property is
// the equivalent of a class's `static Config`, and it is what the declarative
// host's settings service uses as this entry's namespace. The named exports
// above stay for direct importers; the loader unwraps `default` first.
export default { name, inject, Config, apply }

// Re-export the config contract for backward compatibility (the same public
// names as before the config.js split). isPlainObject/cloneSettings stay
// module-private, mirroring dsh-tool-adapt's narrower index surface.
export { SETTINGS_NS, DEFAULT_SETTINGS, validateSettings }
