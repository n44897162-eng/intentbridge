# Contributing

Thanks for helping IntentBridge. This repository is a local-first reference
implementation; please keep the security model (loopback only, no cloud, no
plaintext secrets) intact.

## Setup

Requirements:

- Node.js 24.x and pnpm 12.x (`corepack enable`)
- Rust 1.89 (pinned by `rust-toolchain.toml`) with `wasm32-unknown-unknown`
- For platform builds only: .NET 8, JDK 17, Android SDK 35, NDK 29, Gradle 8.9
- A display for headed Chromium extension tests (CI uses `xvfb-run`)

```bash
pnpm install --frozen-lockfile
cargo build -p ib-runtime --lib --release --target wasm32-unknown-unknown
node scripts/copy-wasm.mjs
pnpm build
pnpm gate
```

`pnpm gate` runs typecheck, rustfmt, clippy, all Rust/TS tests, the Web
golden corpus, drift corpus, soak tests, lint, formatting and SBOM. Platform
builds are optional and print `NOT_RUN` when their toolchains are absent.

## Rules

- Do not add real credentials, browser profiles, recordings of third-party
  sites, or machine-specific absolute paths.
- Run `pnpm format` before opening a PR.
- Change the Action IR only with a schema-version migration and conformance
  tests.
- Keep generated binaries out of git; use `pnpm package` / GitHub Releases.
- Document intentional limitations in `BUGLOG.md` or `ASSUMPTIONS.md` rather
  than silently working around them.

## Pull requests

Include the user-visible behavior, the exact verification command, and any
`NOT_RUN` item with its reason. CI must pass on Linux; Windows/Android jobs are
compile-only until real-device verification exists.
