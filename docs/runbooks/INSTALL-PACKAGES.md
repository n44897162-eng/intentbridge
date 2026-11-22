# 产物安装、升级与卸载

所有产物与 SHA-256 见 `artifacts/SHA256SUMS`，组件清单见 `sbom/intentbridge-sbom.json`。

## Web 扩展（MV3）

- 包：`artifacts/intentbridge-extension-0.1.0.zip`（生产 manifest，无默认站点权限）。
- 开发安装：解压后在 `chrome://extensions` 打开开发者模式，选择“加载已解压的扩展程序”指向解压目录。
- 升级：替换目录后点击扩展卡片上的刷新；`chrome.storage.local` 中的流程保留。
- 卸载：移除扩展即删除扩展存储；不影响管理端 `.data`。
- 权限：首次在某站点使用需用户显式授权（或通过扩展 action 的 activeTab）。

## Android（debug APK，非生产签名）

- `artifacts/android/IntentBridge-0.1.0-debug.apk`，含 arm64-v8a / x86_64 JNI。
- 安装：

```bash
adb install -r artifacts/android/IntentBridge-0.1.0-debug.apk
adb install -r artifacts/android/IntentBridgeFixture-0.1.0-debug.apk
```

- 升级：同一 debug 签名下 `adb install -r` 保留应用私有数据（流程数据库）。
- 卸载：`adb uninstall com.intentbridge.app` 会删除应用数据；如需保留，先备份 `/data/data/com.intentbridge.app/databases/intentbridge.db`（需要 root/debuggable）。
- 这是 **debug 签名**，不用于分发；M6 的生产签名/商店包未完成（BUG-014）。
- 运行前提：在系统设置中手动启用 IntentBridge 无障碍服务；容器/无设备环境无法执行验证。

## Windows（编译验证产物）

- `artifacts/windows/*.dll` 是 Linux 交叉编译的托管程序集，用于证明源码可编译；**不是可直接双击的 Windows 安装包**。
- 在 Windows 上生成可运行产物：

```powershell
dotnet publish apps\windows-executor\IntentBridge.Executor.csproj -c Release -r win-x64 --self-contained false
cargo build -p ib-runtime --release --target x86_64-pc-windows-msvc
# 将 ib_runtime.dll 放到 publish 输出目录
```

- 升级/回滚：替换发布目录；运行数据默认在 `%LOCALAPPDATA%\IntentBridge`（实现于 Windows 壳层，当前未交付）。
- 卸载：删除发布目录与上述数据目录。
- 密钥：`secret://alias` 从 Windows 凭据管理器读取通用凭据 `IntentBridge:<alias>`，不落盘：

```powershell
cmdkey /generic:IntentBridge:bank-pin /user:intentbridge /pass:<口令>
```

可用 `cmdkey /delete:IntentBridge:bank-pin` 删除。需要 `advapi32` 的 `CredReadW`；未配置时动作返回 `SECRET_NOT_FOUND`，不会把别名敲进目标。

- UIA 运行时验收未完成（BUG-001）。

## 源码包

`artifacts/intentbridge-0.1.0-source.tar.gz` 包含源码、锁文件、夹具与文档，不含 node_modules/target/构建产物。解压后按 `docs/runbooks/INSTALL.md` 构建。
