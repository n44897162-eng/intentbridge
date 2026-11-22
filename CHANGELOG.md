# Changelog

## 0.1.0 — 2026-11-22

First reference implementation of the IntentBridge contract.

### Added

- Versioned Action IR, JSON Schema, migrations, canonical JSON and hashing.
- Rust deterministic engine for native, WASM, C ABI and JNI transports.
- Anchor ranking across native, semantic, structure and visual evidence.
- Real Chrome runner: record, replay, evidence, approval and drift re-anchoring.
- 21 Web golden flows, 9 drift cases, 30-run Web soak and 500-run engine soak.
- SQLite shell with revisions, events, encrypted packages, encrypted secrets,
  backups and a local management UI.
- MV3 extension with WASM engine, activeTab permission, popup and cross-navigation
  recording; visual dHash and sensitive-approval evidence.
- Windows .NET 8 UIA executor/fixture and Android accessibility app/fixture;
  both compile in this repository, runtime verification is tracked as NOT_RUN.
- CI for Linux verification, Windows compile and Android APK/JNI build.

### Known limitations

See `BUGLOG.md` and `docs/TEST-REPORT.md`. In particular: Windows/Android runtime
verification, signed production installers, 10 MB package / 2 hour soak, and
cross-origin recording remain unscheduled or constrained.
