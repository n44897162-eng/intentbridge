# Android app (source complete, build/run NOT_RUN here)

This slice is Kotlin, `minSdk 29`, AccessibilityService for **user-started**
recording/execution, and the shared Rust engine through JNI. No Android SDK or
emulator exists in the Linux verification environment, so build and instrumented
tests are explicitly `NOT_RUN`; see `docs/TEST-REPORT.md`.

## Why the JNI bridge

`core/runtime-rs` is the single state machine. `NativeEngine.kt` calls
`Java_com_intentbridge_app_NativeEngine_*` functions implemented in
`core/runtime-rs/src/jni_android.rs`; the same JSON protocol used by web/WASM and
Windows/C-ABI is passed through unchanged.

## Build (host with Android SDK 35)

Gradle wrapper is not checked in (this environment has no Android SDK); use Android Studio's wrapper or `gradle wrapper --gradle-version 8.9` first.

```bash
cd apps/android-app
./gradlew :app:assembleDebug :app:connectedDebugAndroidTest
```

## Security notes

- The accessibility service is only active when the user enables it in system
  settings; a persistent notification shows recording/execution.
- Password fields are detected via `AccessibilityNodeInfo.isPassword` and are
  never captured or typed from logs.
- The foreground package is checked before every action; leaving the package
  pauses the run.
- Secrets use Android Keystore-wrapped AES-GCM values, never the IR.
