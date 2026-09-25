# dsh-mcp-pill

## English

**Current release: 0.2.6** — Portable settings transport: the plugin now resolves its settings scope on both the `settingsScope` (≤ 0.1.5) and `configForms` (≥ 0.1.7-rc.1) hosts, so the Settings card keeps working across the rename.

A lifecycle-safe MCP connection status pill for DeepSeek Harness Web. It exposes loopback-fenced status/toggle RPC, an official Settings card, and a composer-seat pill that stays hidden until enabled. DSH 0.1.2+ fine-grained `remote.settings` is preferred; older RC hosts use the legacy connection API.

## 中文

用于 DeepSeek Harness Web 的生命周期安全 MCP 连接状态胶囊。提供本机同源 RPC、官方设置卡片和输入框状态胶囊；优先使用 DSH 0.1.2+ 的 `remote.settings`，旧版 RC 自动回退到 connection API。

Global MCP connection status pill for the DSH web UI — official bundle form
(host RPC + `__ModuleLoader__` client, no tapIndex injection).

- `GET /api/mcp-pill/status` — JSON status of every configured MCP connection
  plus `pill.enabled`, the hot host mirror of the visibility toggle.
- `POST /api/mcp-pill/set` — `{ id, enabled }` toggles a connection via the
  patch file's `disabled` marker (loader HMR applies it).
- The pill is hidden by DEFAULT. An official-style expandable Settings Card
  owns one switch, 「显示状态胶囊」(`pill.enabled`, default `false`); while it is
  off the pill never mounts visibly, and toggling it takes effect within one
  status poll (instantly after a save in the same tab).
- That card registers on BOTH settings seats, because DSH moved it: the keyed
  row seat `plugins.row.config` (key `dsh-mcp-pill#mcp-pill`) on
  DSH ≥ 0.1.7-rc.2, and the legacy item seat `settings.plugin.item`
  (key `mcp-pill`) on ≤ 0.1.5. Each seat is declared by one host only, so the two
  registrations coexist with no version sniffing and the card always has a home;
  values keep flowing through the single settings transport
  (`settingsScope` on ≤ 0.1.5, `configForms` on ≥ 0.1.7).
- The pill snaps to one of the chat input's four corners (drag to switch);
  the anchor is remembered in `localStorage` (`dsh.mcpPill.anchor`).
- The pill mounts inside the composer seat (same stacking level as the input
  box) at a normal `z-index`, so DSH web popups (modal / menu / toast) can
  cover it instead of being hidden behind it.

## Install

```powershell
dsh plugin --profile web add dsh-mcp-pill
```

Restart the existing DSH Web process afterwards: the Host scans the browser plugin roster at startup, so the pill and its Settings card appear only after that restart. Then open **Settings → Plugins**, open the `dsh-mcp-pill` entry (`mcp-pill` row) and turn on「显示状态胶囊」— the pill is hidden by default. On DSH ≥ 0.1.7-rc.2 that configuration lives in the row's configure control; on ≤ 0.1.5 it is the card in the Settings → Plugins list.

Local development, from this package directory:

```powershell
dsh plugin --profile web add .
```

Either form records the package in the profile's `dsh.profile.bundles`, which is what mounts the Host half and serves the client bundle.

## Config

The mounting row (in this package's `cordis.patch.yml`) passes
`config.patchFile` — the `cordis.patch.yml` holding the `dsh-mcp-client` rows,
resolved against the profile working directory (default `<cwd>/cordis.patch.yml`).
