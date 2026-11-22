# 平台构建报告（2026-11-22）

本报告区分 **构建** 与 **运行**。构建通过不等于 OS 自动化已经实机验证。

## Windows（.NET 8 + WPF + UIA）

- 工具链：.NET SDK **8.0.428**（Linux 交叉编译，`EnableWindowsTargeting` + WindowsDesktop 引用包）。
- 命令：

```bash
dotnet build fixtures/windows-fixture/IntentBridge.Fixture.csproj -c Release
dotnet build apps/windows-executor/IntentBridge.Executor.csproj -c Release
```

- 结果：两个项目均 **Build succeeded，0 warning / 0 error**。
- 产物：`artifacts/windows/*.dll`、deps/runtimeconfig。
- 未验证：UIA 在真实 Windows 桌面的行为、DPI/多显示器/UAC、NamedPipe IPC 跨用户、Rust `ib_runtime.dll` 的 Windows 链接（本机没有 MSVC/Windows 目标）。
- 复现：`node scripts/build-platforms.mjs`。

## Android（Kotlin + AccessibilityService + JNI）

- 工具链：JDK 17、Android SDK 35、Build-Tools 35.0.0、NDK **29.0.14206865**、Gradle 8.9、Rust 1.89（`aarch64-linux-android` + `x86_64-linux-android`）。
- 命令：

```bash
node scripts/build-platforms.mjs
# 等价手动步骤：
cargo build -p ib-runtime --release --target aarch64-linux-android
cargo build -p ib-runtime --release --target x86_64-linux-android
cp target/aarch64-linux-android/release/libib_runtime.so apps/android-app/app/src/main/jniLibs/arm64-v8a/
cp target/x86_64-linux-android/release/libib_runtime.so apps/android-app/app/src/main/jniLibs/x86_64/
gradle -p apps/android-app :app:assembleDebug --no-daemon
gradle -p fixtures/android-fixture :app:assembleDebug --no-daemon
```

- 结果：两个 APK **BUILD SUCCESSFUL**；`app-debug.apk` 14 MB，包含
  `lib/arm64-v8a/libib_runtime.so` 与 `lib/x86_64/libib_runtime.so`。
- JNI 符号已验证：

```text
Java_com_intentbridge_app_NativeEngine_nativeNew
Java_com_intentbridge_app_NativeEngine_nativeCommand
Java_com_intentbridge_app_NativeEngine_nativeDestroy
```

- 未验证：设备/模拟器运行（容器无 `/dev/kvm`）、无障碍服务交互、字体/DPI/深色模式、Activity 重建、WorkManager 厂商限制。
- 复现：`node scripts/build-platforms.mjs`（缺少 SDK/NDK 时会显式 NOT_RUN）。

## 产物与校验和

见 `artifacts/SHA256SUMS`：Android APK、Windows 托管程序集、扩展 zip、源码 tar.gz。

| 产物                                                    | 大小            |
| ------------------------------------------------------- | --------------- |
| `artifacts/android/IntentBridge-0.1.0-debug.apk`        | 14 MB（含 JNI） |
| `artifacts/android/IntentBridgeFixture-0.1.0-debug.apk` | 7.0 MB          |
| `artifacts/intentbridge-extension-0.1.0.zip`            | 669 KB          |
| `artifacts/windows/IntentBridge.Executor.dll`           | 32 KB           |
| `artifacts/windows/IntentBridge.Fixture.dll`            | 13 KB           |

## 结论

- “源码完成但完全没构建”的说法已更新：**Windows 与 Android 均可复现构建**。
- 仍不能宣称 M2/M3 通过：任务书要求的是 UIA/无障碍的真实操作验收，本机没有 Windows/Android 运行环境。
