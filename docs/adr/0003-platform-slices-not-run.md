# ADR-0003: Windows/Android 源码切片与虚拟一致性的验收边界

状态：接受（2026-01）

## 背景

验证机是 4 核 4G Linux，没有 Windows、.NET SDK、Android SDK 或可用模拟器。任务书禁止伪造平台实测。

## 决策

1. Windows 与 Android 提供**可构建目标的源码、夹具、权限声明、IPC/JNI 边界**，但本次不宣称构建/运行通过；`docs/TEST-REPORT.md` 明确 `NOT_RUN` 与复现命令。
2. 三端语义一致性用 Rust 虚拟 Provider 测试：同一 Action IR 序列（launch/input/click/end）在 web/windows/android 三种 app_scope 与候选形态下产生相同状态、相同事件类别、相同错误码；这验证的是**引擎与协议**，不是 OS 自动化。
3. 锚点评分单元测试覆盖 native/语义/结构/视觉、消歧、错误 scope、移动、视觉单独等。
4. 拒绝用截图或无断言脚本充当“平台实测”。

## 后果

- 交付诚实：可在 Windows/Android 环境按 README 复现构建；但不能声称这三端已达到 DoD。
- CI 只对 Linux 可验证部分 fail-closed；Windows/Android 构建任务在 CI 中显式标记为待启用，不伪造绿灯。
