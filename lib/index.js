// dsh-mcp-pill — host half (official bundle form)
//
// Serves the JSON RPC for the client half:
//   GET  /api/mcp-pill/status  -> JSON status of every configured MCP connection
//                                 plus `pill.enabled` (the visibility toggle)
//   POST /api/mcp-pill/set     -> { id, enabled } toggles a connection via the
//                                 patch file's `disabled` marker (loader HMR applies it)
//
// The visibility of the pill itself is owned by the official settings service:
// this half registers the `mcp-pill` namespace ({ pill: { enabled: false } })
// and mirrors the resolved value into every /status response, so the client
// half can follow it with its existing poll loop. Default is OFF.
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

  function readPillEnabled(scope) {
    try {
      const value = scope.get()
      return !!(isPlainObject(value) && isPlainObject(value.pill) && value.pill.enabled === true)
    } catch (_) {
      return false
    }
  }

  ctx.inject(['settings'], (sctx) => {
    try {
      const schema = Schema.object({
        pill: Schema.object({
          enabled: Schema.boolean().default(DEFAULT_SETTINGS.pill.enabled),
        }).default(cloneSettings(DEFAULT_SETTINGS.pill)),
      })
      const scope = sctx.settings.register(SETTINGS_NS, schema, {
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
        return { ok: true, patchFile, warning: msg, pill: { enabled: pillState.enabled }, entries: [] }
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
      pill: { enabled: pillState.enabled },
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

// Re-export the config contract for backward compatibility (the same public
// names as before the config.js split). isPlainObject/cloneSettings stay
// module-private, mirroring dsh-tool-adapt's narrower index surface.
export { SETTINGS_NS, DEFAULT_SETTINGS, validateSettings }
