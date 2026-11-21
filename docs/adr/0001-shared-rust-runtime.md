# ADR-0001: 单一 Rust 状态机 + JSON 命令通道

状态：接受（2026-01）

## 背景

任务书硬约束：三端必须复用同一套状态机；Web 用 WASM、Windows 用本地服务、Android 用 JNI；不得三份 if/else；核心不依赖真实时间/随机数/线程。

## 决策

1. `core/runtime-rs` 是唯一状态机与条件/重试/审批/审计实现，不直接访问 OS。
2. 宿主与引擎之间只传 JSON（`schema_version` + `cmd` 或 `directive`），三种边界：
   - WASM：`ib_new/ib_cmd/ib_response_ptr/ib_response_len`；
   - 原生：同样的 C ABI，Windows 通过 P/Invoke，Android 通过 JNI 包装；
   - 命令行：JSON-lines，供测试与桌面排障。
3. 平台能力只通过 `ResolveTarget / PerformAction / Observation / ActionDone / Tick ...` 协议进出；引擎不 import 任何平台库。
4. 时间、随机抖动、事件 ID 都由宿主注入的 `now_mono_ms` 与确定性哈希派生。
5. Anchor 评分是独立纯函数 crate，可单独测试和替换。

## 后果

- 三端语义测试可以完全脱离真实 UI（虚拟 Provider + 条件/事件注入）。
- WASM 体积约 2.3 MB（未压缩），包含正则引擎；可接受，但需要构建后校验。
- 协议演进必须同时修改 Rust serde、TS 类型和测试；有 `schema_version` 与 conformance 测试保护。
- 原生 C ABI 的原始指针函数在 Rust 语义上是 unsafe；`abi.rs` 显式 allow 并以“宿主复制响应后再调用”为契约，已写入注释。

## 替代方案与拒绝原因

- 三端各写状态机：违反硬约束，无法做统一模型测试。
- 进程外引擎 + 本地 IPC（Windows 服务）：可选，但 Web 没有等价物，WASM 是更小公倍数。
- 让引擎直接调用 PowerShell/adb/DOM：破坏可测试性与安全边界。
