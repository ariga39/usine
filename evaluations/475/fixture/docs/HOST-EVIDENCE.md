# Representative host contract

The public poi revision is `120fe5307a27b7bccc0569fe9df4b646d3d7f9ac`:

- [Loader and lifecycle](https://github.com/poooi/poi/blob/120fe5307a27b7bccc0569fe9df4b646d3d7f9ac/views/services/plugin-manager/lifecycle.ts) resolve the package, import its built entry, and invoke `pluginDidLoad()` / `pluginWillUnload()` without an injected host. Hooks are not awaited.
- [Metadata](https://github.com/poooi/poi/blob/120fe5307a27b7bccc0569fe9df4b646d3d7f9ac/views/services/plugin-manager/read-plugin.tsx) reads `package.poiPlugin`; optional fields have fallbacks. [Types](https://github.com/poooi/poi/blob/120fe5307a27b7bccc0569fe9df4b646d3d7f9ac/views/services/plugin-manager/types.ts) exposes a React `settingsClass`.
- [Configuration](https://github.com/poooi/poi/blob/120fe5307a27b7bccc0569fe9df4b646d3d7f9ac/lib/config.ts) supports dotted-path `get` / `set`, `on` / `removeListener`, and emits `config.set(path, value)` after a changed value is stored.
- [Store](https://github.com/poooi/poi/blob/120fe5307a27b7bccc0569fe9df4b646d3d7f9ac/views/redux/create-store.ts) exposes `getStore(path?)` and the deprecated but real `window.getStore` global; `window.config` is real. There is no established `global.store`.
- [Reference plugin](https://github.com/poooi/plugin-ship-info/blob/9e81140209e88d2ab904d716d1bb28782a1d681a/index-src.ts) uses the real load hook and host configuration. Its legacy build tooling is not the requested toolchain.

For this small case, expose only `info.resources` at `GET /api/v1/snapshot`, as `{ "resources": [...] }`; never expose arbitrary state. Use `plugin.Server.enabled`, `plugin.Server.port`, `plugin.Server.lan`, and `plugin.Server.token` settings. Missing enabled/LAN settings default false; enabled service defaults to loopback. Settings are rendered by a real React component and configuration changes take effect without plugin reload.

All requests require a bearer token. Reject query credentials, non-GET methods, and untrusted Host/Origin. LAN is explicit opt-in and does not disable authentication. This case deliberately does not support a reverse proxy or forwarded host/origin overrides; deployment documentation must say so rather than promise an untested TLS-proxy setup. WebSocket/MCP and full poi/Electron UI automation are excluded.

Run the real pnpm/Vite+ scripts. Built-entry tests derive host behavior from the linked source, not an implementation-defined injected interface. Inspect the public source when a supplied interpretation is unclear; dependency installation and public source reads are allowed.
