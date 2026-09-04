import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── pill mounting: seat-only, waits, no off-page floating pill ──────────────

test('pill mounts only under the composer seat and waits for it', () => {
  assert.match(source, /ctx\.effect\(\(\) => startPill\(scope\), 'dsh-mcp-pill: composer pill'\)/)
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
  assert.match(source, /ctx\.slots\.inject\('settings\.plugin\.item'/)
  assert.match(source, /key: NS/)
  assert.match(source, /label: 'MCP Pill'/)
  assert.match(source, /function SettingsCard/)
  assert.match(source, /e\('li'/)
  assert.match(source, /api\.settings\.mutate/)
  assert.match(source, /expectedRevision/)
  assert.match(source, /\{ path: \['pill', 'enabled'\], kind: 'bool', label: '显示状态胶囊'/)
  assert.match(source, /默认关闭/)
  assert.match(source, /exports\.inject = \['slots', 'settingsScope', 'connection', 'remote\.settings'\]/)
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