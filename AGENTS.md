# dsh-mcp-pill Maintenance Guide

## Purpose

Small global MCP connection status/toggle plugin:

- Host: `GET /api/mcp-pill/status` (also mirrors the pill toggle as `pill.enabled`) and `POST /api/mcp-pill/set`; registers the official settings namespace `mcp-pill`.
- Client: composer-attached status pill plus an official Settings card (`settings.plugin.item` / key `mcp-pill`) with the「显示状态胶囊」toggle, loaded through `window.__ModuleLoader__`.

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
- Mount inside `[data-composer-seat]` with a normal stacking level. Menus, dialogs, and toasts must cover the pill.
- Anchor persistence key is `dsh.mcpPill.anchor`; keep it separate from tool-adapt.
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
