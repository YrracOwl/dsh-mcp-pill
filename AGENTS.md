# dsh-mcp-pill Maintenance Guide

## Purpose

Small global MCP connection status/toggle plugin:

- Host: `GET /api/mcp-pill/status` (also mirrors the pill toggle as `pill.enabled`) and `POST /api/mcp-pill/set`; registers the official settings namespace `mcp-pill`.
- Client: composer-attached status pill plus an official Settings card with the「显示状态胶囊」toggle, registered on BOTH card seats — the legacy `settings.plugin.item` (key `mcp-pill`, declared by ≤ 0.1.5) and the rc.2 keyed row seat `plugins.row.config` (key `ROW_CONFIG_KEY` = `dsh-mcp-pill#mcp-pill`) — loaded through `window.__ModuleLoader__`.

Keep this package focused. It reports and toggles MCP rows; it does not own MCP transport implementation or tool adaptation.

## Key Files

- `lib/index.js`: reads configured MCP rows, applies enabled/disabled changes to the configured patch file, serves fenced RPC, and registers the settings namespace whose resolved `pill.enabled` is mirrored into `/status`.
- `lib/client.js`: polling/status UI, official Settings card (React, `dmp`-prefixed chrome), four-corner drag anchor, composer-seat mounting, visibility gate, cleanup.
- `cordis.patch.yml`: mounts `mcp-pill` and resolves `patchFile` relative to the Web profile cwd.

## Invariants

- No `tapIndex` injection and no `/ui.js` route. Client code is the exported `__ModuleLoader__` bundle.
- RPC must remain loopback/same-origin fenced and accept only the documented status/toggle operations.
- Toggling uses the target row's `disabled` marker and relies on loader HMR; do not rewrite unrelated patch content.
- The pill stays hidden until `pill.enabled` in the `mcp-pill` settings namespace is true (default `false`); `/status` mirrors it for the client poll. Never mount the root unconditionally.
- Settings reach the Host two ways. ≤ 0.1.5 registers the `mcp-pill` namespace with `ctx.settings.register(...)` and mirrors the resolved scope. ≥ 0.1.7 has no `register`: the namespace IS the entry's exported `Config`, keyed by the loader entry id `mcp-pill`, whose `pill.enabled` leaf carries `.volatile()` — applied by capability, since the 0.1.5 schemastery has no such method and an unconditional call would throw at module load. `/status` must read that value through the Symbol-keyed unwrap (`Symbol.for('cosmokit.volatile.write')`, then `.get()`) on every call, because the service updates it in place without remounting; never cache it at apply time. `ctx.settings.configure({ auto: false }, ctx.fiber)` declares that this plugin renders its own card rather than a generated page.
- Mount inside `[data-composer-seat]` with a normal stacking level. Menus, dialogs, and toasts must cover the pill.
- Anchor persistence key is `dsh.mcpPill.anchor`; keep it separate from tool-adapt.
- The Settings card must stay registered on BOTH seats, because each host declares only one of them. ≤ 0.1.5 declares `settings.plugin.item` (key `mcp-pill`); 0.1.7-rc.2 REMOVED that slot, and a bundle row's configuration seat is the keyed `plugins.row.config`, whose key constant `ROW_CONFIG_KEY` must equal `` `${package.json#name}#<the row id in cordis.patch.yml>` `` (`dsh-mcp-pill#mcp-pill`) — the official plugin-manager shows a row's configure control only while an occupant holds that exact key, so a card left on one seat renders nowhere, silently. The rc.2 occupant must render a one-liner alone for `view === 'summary'` and the existing card for `view === 'page'`, must not consume the optional host-owned `form` prop (values keep flowing through the single transport), and must be registered from inside a non-gating `ctx.inject(['slots'], …)` callback that returns the registration disposer.
- Every observer, poll/timer, drag listener, and mounted node must be disposed on plugin unload/update.

## Validation

Run the declared test suite (`node --test`, includes `test/client-lifecycle.test.mjs` mounting/lifecycle source guards) plus explicit checks:

```powershell
npm test
node --check lib/index.js
node --check lib/client.js
npm pack --dry-run
```

After `dsh plugin --profile web add .`, verify both RPC routes and the real `3080` pill. Toggle a disposable/test MCP row where possible and confirm only its `disabled` state changes.

## Pitfalls

- A visible pill does not prove the Host route or target `patchFile` is correct.
- Avoid extreme z-index and body-level mounting; these previously caused the pill to cover product overlays.
- The default `patchFile: cordis.patch.yml` is profile-relative, not package-relative.

## Documentation

- `README.md` is the only user-facing install surface: keep its recommended `dsh plugin --profile web add dsh-mcp-pill` command, the required DSH Web restart, and the「显示状态胶囊」default-off note current whenever the install or visibility behavior changes.
