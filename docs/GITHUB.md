# 上传到 GitHub

## 方式 A：命令行（推荐）

```bash
cd /root/dsh/intentbridge
git remote add origin git@github.com:<owner>/<repo>.git
git branch -M main
git push -u origin main
git tag -a v0.1.0 -m "IntentBridge 0.1.0"
git push origin v0.1.0
```

不要上传 `node_modules/`、`target/`、`.data/`、`dist/`、`.gradle/`；它们已在
`.gitignore` 中。构建产物由 `release.yml` 在 tag 上生成并挂到 GitHub Release，
不进入源码历史。

## 方式 B：网页上传

1. 新建空仓库（不要勾选自动生成 README/LICENSE）。
2. 只上传源码目录，排除 `.git/`、`node_modules/`、`target/`、`.data/`、
   `dist/` 与 `build/`。需要完整历史时使用方式 A。
3. GitHub 网页单文件上限 25 MB；本仓库源码最大文件是 WASM 运行包（约 2.3 MB），
   不需要 Git LFS。

## 发布产物

在 tag 上运行 `release` workflow 后，Release 会包含：

- `IntentBridge-0.1.0-debug.apk` 与 `IntentBridgeFixture-0.1.0-debug.apk`
- `intentbridge-extension-0.1.0.zip`
- `intentbridge-0.1.0-source.tar.gz`
- `SHA256SUMS`

本地复现：

```bash
pnpm install --frozen-lockfile
cargo build -p ib-runtime --lib --release --target wasm32-unknown-unknown
node scripts/copy-wasm.mjs
pnpm -r --if-present run build
node scripts/build-platforms.mjs   # 需要 .NET 8 / Android SDK / NDK / Gradle
node scripts/package.mjs
```

## CI

- `verify.yml`（`ci.yml`）：Linux 真实 Chrome + WASM 全量门禁；Windows 编译；
  Android APK + JNI 编译。
- `release.yml`：tag `v*` 时构建并发布二进制产物。

首次 push 前检查：

```bash
git status --short
node scripts/gate.mjs
```
