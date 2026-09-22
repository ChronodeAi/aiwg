# AIWG Cockpit — Desktop shell (Tauri v2)

A lightweight native window hosting the **same registry-bound Bridge UI** as the
VS Code shell and the browser. The shell does not replace the CLI or reimplement
the control plane — `src-tauri/src/main.rs` waits for the Bridge's per-launch
runtime handshake file (`~/.aiwg/cockpit/runtime/bridge.json`), exchanges the
native credential for a one-time nonce, and opens the Bridge UI without a
reusable credential in the URL.

## Architecture

```
operator/CLI: aiwg cockpit
      │  (spawns the Bridge; writes OS keychain token + runtime/bridge.json mode 600)
      ▼
Bridge (127.0.0.1:PORT, token-gated /api) ── proxies ──▶ agentic-sandbox executor
      ▲
      │  loads http://127.0.0.1:PORT/#bootstrap=…
desktop window  (this app)   ◀── same UI ──▶   VS Code webview  /  browser
```

## Build

Requires the Rust toolchain + Tauri prerequisites. On Linux: `webkit2gtk-4.1`,
`libsoup-3.0`, `libappindicator`. Then:

```bash
cargo install tauri-cli --version '^2'   # once
cd apps/cockpit/desktop
cargo tauri dev                           # run against a launched Bridge
cargo tauri build                         # produce a bundle
```

The repo ships the load-the-Bridge logic (`main.rs`), the Tauri config, the
frontend splash, a locked Rust dependency graph, and the generated desktop icon
set needed by Tauri. `cargo tauri build` has been verified on Linux to produce
`.deb`, `.rpm`, and `.AppImage` bundles.

## Linux dependency security boundary

The desktop does not accept XML or plist input at its application boundary.
Tauri's build/configuration stack brings in `plist` and `quick-xml`; the locked
graph must retain `quick-xml >=0.41.0` so crafted duplicate attributes or
namespace declarations cannot trigger the RustSec denial-of-service flaws even
if that upstream boundary changes.

Linux rendering remains owned by the Cockpit maintainers and currently follows
Tauri/Wry's GTK backend. Tauri 2.11.5 and Wry 0.55.1 still require GTK3 bindings
and `glib 0.18`; upgrading `glib` alone is ABI/API incompatible. The upstream
GTK4 migration is tracked by `tauri-apps/tauri#12561` and the related Tao/Wry
GTK4 work. Before the next desktop release, maintainers must either qualify an
upstream GTK4 release that resolves `glib >=0.20` or hold the Linux bundle. A
floating Git dependency or an audit ignore is not an accepted remediation.

Re-check 2026-09-13 (roctinam/aiwg#2203): the Linux bundle hold remains in
force. `tauri 3.0.0-alpha.0` (published 2026-09-13) is the first upstream
release to expose a `gtk4` feature, but its `tauri-runtime-wry 3.0.0-alpha.0`
still depends unconditionally on `gtk ^0.18` and `wry ^0.56`, and the current
stable line (`tauri 2.11.5`, `wry 0.57.0`, `tao 0.37.0`) still declares
`gtk ^0.18`, so every released graph resolves `glib 0.18.5` and `cargo audit`
still reports `RUSTSEC-2024-0429`. Alpha releases are not qualification
candidates; re-evaluate when a stable Tauri 3 line ships a GTK4 runtime. The
same audit lists six unmaintained crates (`proc-macro-error` and the `unic-*`
family), all reached through the GTK3 stack; they carry the same owner and
migration decision as the `glib` line. Next scheduled review: 2026-10-05.

Update pass 2026-09-13 (operator-authorized): `cargo update` refreshed the
locked graph to the latest semver-compatible versions (41 crates, including
`quick-xml 0.42.0`); the GTK3 stack is unaffected because
`tauri-runtime-wry 2.11.4` pins `wry ^0.55`, `tao ^0.35`, and `gtk ^0.18`.
Tauri 3.0.0-alpha.0 was resolved in a scratch copy to test the GTK4 path:
its `gtk4` feature only switches `muda` menus and the tray to GTK4, the
webview runtime now lives in a separate `tauri-runtime-wry 3.0.0-alpha.0`
crate that still requires `wry ^0.56` / `tao ^0.37` / `webkit2gtk 2.0` on
GTK3, and the resulting graph carries both `glib 0.22.9` and `glib 0.18.5`
with `RUSTSEC-2024-0429` still reported. The alpha also requires Rust 1.95.
No released Tauri line can remove the advisory until Wry ships a WebKitGTK 6
(GTK4) backend.

## Why a token file (not a socket handshake)

The runtime file is the cross-platform handshake every shell shares (see
`apps/cockpit/shell-core/runtime.mjs`). The Bridge stores the per-launch token in
the OS credential backend when available and records a `token_ref`; `bridge.json`
is mode `600` and records explicit fallback evidence when no backend is usable.
