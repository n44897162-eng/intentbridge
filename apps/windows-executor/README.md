# Windows executor (source complete, build/run NOT_RUN here)

The Windows slice targets .NET 8 + UI Automation. It is **not** built or executed in
this repository's Linux verification environment; see `docs/TEST-REPORT.md` for the
exact NOT_RUN reason and the command to reproduce on Windows.

## Build (Windows)

```powershell
rustup target add x86_64-pc-windows-msvc
cargo build -p ib-runtime --release --target x86_64-pc-windows-msvc
copy target\x86_64-pc-windows-msvc\release\ib_runtime.dll apps\windows-executor\bin\Release\net8.0-windows\
dotnet build apps\windows-executor\IntentBridge.Executor.csproj -c Release
```

## Run

```powershell
dotnet apps\windows-executor\bin\Release\net8.0-windows\IntentBridge.Executor.dll serve
```

The first line printed on stdout is `{"endpoint":"...","token":"..."}`. The client
must include that token in every request. There is no TCP listener and no default
non-loopback exposure.

## Scope of this slice

- UIA observation, patterns-only actions, scope checks, named-pipe IPC, Rust engine FFI.
- `record` streams UIA invoke/focus observations as NDJSON for the shared editor.
- **Not implemented here:** packaged installer, tray UI, WinAppDriver integration
  (not needed), automatic DPI-per-monitor restart handling, and the approval UI.
  Those are tracked in `BUGLOG.md` with severity.
