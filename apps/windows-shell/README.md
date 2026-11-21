# Windows shell (NOT_IMPLEMENTED in this environment)

The P0 management UI is served by `apps/web-shell` over loopback and is fully
usable from any browser on the machine. A Tauri/WebView2 shell is optional per
the task book ("桌面管理 UI 可用 Tauri，复用 TypeScript 编辑器").

This directory intentionally contains no half-built shell. The intended wrapper
is a Tauri application whose main window loads the loopback URL printed by
`apps/web-shell`; it must not duplicate editor logic. Tracked as BUG-014 / ADR-0002.
