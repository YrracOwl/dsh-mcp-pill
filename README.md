# dsh-mcp-pill

Global MCP connection status pill for the DSH web UI — official bundle form
(host RPC + `__ModuleLoader__` client, no tapIndex injection).

- `GET /api/mcp-pill/status` — JSON status of every configured MCP connection
  plus `pill.enabled`, the hot host mirror of the visibility toggle.
- `POST /api/mcp-pill/set` — `{ id, enabled }` toggles a connection via the
  patch file's `disabled` marker (loader HMR applies it).
- The pill is hidden by DEFAULT. An official-style expandable Settings Card
  (`settings.plugin.item` / key `mcp-pill`) owns one switch,
  「显示状态胶囊」(`pill.enabled`, default `false`); while it is off the pill
  never mounts visibly, and toggling it takes effect within one status poll
  (instantly after a save in the same tab).
- The pill snaps to one of the chat input's four corners (drag to switch);
  the anchor is remembered in `localStorage` (`dsh.mcpPill.anchor`).
- The pill mounts inside the composer seat (same stacking level as the input
  box) at a normal `z-index`, so DSH web popups (modal / menu / toast) can
  cover it instead of being hidden behind it.

## Install

Add to the profile's `package.json` dependencies (`link:` for local dev) and
to `dsh.profile.bundles`, then `pnpm install` and restart `dsh web`.

## Config

The mounting row (in this package's `cordis.patch.yml`) passes
`config.patchFile` — the `cordis.patch.yml` holding the `dsh-mcp-client` rows,
resolved against the profile working directory (default `<cwd>/cordis.patch.yml`).
