# 假设与偏离记录（ASSUMPTIONS）

任务书第 15 条要求：遇到需求冲突时记录假设，并选择更安全、更确定的行为。本文件是唯一记录处；任何后面的变更都必须追加条目，不能覆盖历史。

## A1. 状态机增加了两个暂停态

任务书 §6.1 列出了 `PAUSED_FOR_APPROVAL / PAUSED_FOR_DISAMBIGUATION`，但“动作副作用未知”和“用户手动暂停/失败后人工接管”都需要一个可以恢复的暂停。实现增加：

- `PAUSED_FOR_OUTCOME`：写动作已提交但无法判断结果，等待人工确认成功/失败/人工授权重试。
- `PAUSED_FOR_RECOVERY`：`on_failure: ask-user`、用户暂停、应用范围越界、单步试运行完成时进入。

同时增加协议指令 `AwaitOutcomeDecision`、`AwaitRecovery`、`AwaitTimer`，取消、恢复和 `OUTCOME_UNKNOWN` 均可审计。没有删除任务书中任何状态。

## A2. 重试的默认语义

任务书 §6.2 说“默认最大重试 2 次、默认写动作不重试，除非步骤声明幂等键”。实现：

- 默认 `max_attempts = max_retries + 1 = 3`，但只读动作才会自动使用；写动作必须有 `retry.idempotency_key`。
- 引擎配置 `max_retries` 是硬上限，步骤上的更大值会被截断，不会突破安装级安全上限。
- 重试之间使用指数退避 + 确定性抖动；退避通过 `AwaitTimer` 交给宿主等待，不在引擎里 sleep。

## A3. “唯一性”和自动执行的证据门槛

任务书 §4.6 要求“结构 + 语义一致可自动执行；只剩视觉或位置只能建议”。实现采用更保守的门槛：

- 原生标识命中 **且** 语义证据 ≥ 0.6 才允许自动执行（防止 AutomationId 被复用）。
- 或语义 ≥ 0.7 且结构 ≥ 0.6。
- 视觉单独命中永远不自动执行；视觉可作为辅助把分数推高，但仍需人工确认（除非显式配置，默认禁用）。
- 候选分数接近（默认 <0.08）必须消歧或暂停。

## A4. 适配器边界与 NOT_RUN

- Web：真实 Playwright/Chrome + MV3 扩展共用 `packages/web-core` 的 DOM 快照与驱动接口。
- Windows/Android：本机为 Linux，没有 .NET/Windows 或 Android SDK/模拟器。源码、夹具、JNI/C-ABI 边界全部提供，但构建和运行标记 `NOT_RUN`，不以虚拟测试冒充实机。跨端一致性用 Rust 虚拟 Provider 测试证明语义一致。
- 没有引入 WinAppDriver（任务书说不是必要依赖）。

## A5. 桌面管理界面

任务书允许 Tauri 复用 TS 编辑器。v1 的本机管理端实现为 `apps/web-shell`（loopback + token + 浏览器 UI），Windows 壳层（Tauri/WebView2）未在无 Windows 环境实现；这是 ADR-0002 记录的偏离，不删除任何 P0 能力。

## A6. 密钥适配器

- Windows/Android 的生产适配器是 DPAPI/Keystore；源码在对应平台切片中。
- Linux 验证环境提供一个**开发用** AES-256-GCM 适配器：密钥文件 `data/keystore/device.key` 0600，值加密后存 SQLite；日志/界面/导出只出现别名。它不是生产密钥方案，已在 SECURITY 与 BUGLOG 标注。
- 浏览器扩展使用 `chrome.storage.session`（浏览器会话内存），关闭浏览器即失效。

## A7. 变量在条件中的解析

任务书要求支持参数化流程。引擎在执行前对条件中的模板做替换（如 `matcher.value = "${keyword}"`），宿主只提供原始观察；这样三端对同一条件的判定完全一致，且条件字符串里不会出现未解析占位符。

## A8. 单步与从选中步骤试运行

管理端需要“单步/从选中步运行”。引擎 `start` 增加 `start_step_id` 与 `single_step`，并写入 `Diagnostic` 事件；单步完成后进入 `PAUSED_FOR_RECOVERY`，用户明确“继续”才走下一步。这样不会把“单步”伪装成完整成功。

## A9. 扩展的输入通道

扩展通过 content script 的 DOM 方法（`element.click()`、原生 value setter + input/change 事件）执行动作，属于 DOM 级自动化；Runner 使用 Playwright 的真实输入。两者共享同一 Rust 引擎与 IR，但浏览器扩展不保证生成 `isTrusted` 事件；这是能力限制，不是安全绕过。需要“真实输入”的无人值守测试使用 Runner。

## A10. 视觉证据的边界

- Runner 对带 `visual.dhash` 锚点的目标，从**视口截图裁剪**计算 64 位 dHash；不保存整屏。
- 扩展暂不计算 dHash（受 captureVisibleTab/权限限制），因此扩展运行纯视觉锚点时会退化为“需确认”；IR 仍保留视觉字段，Runner 可补齐。
- 不训练视觉模型；模板/哈希算法是可测试的纯函数。

## A11. 跨端不做控件等价

IR 按平台独立录制；跨端只复用变量与业务意图。Windows/Android 的 flow 不能直接拿到 Web 上运行，平台校验会拒绝 `app_scope` 不匹配的流程。

## A12. 平台范围与限制

- 同一流程最多 1000 步（Schema）；单次运行最多 100 步（引擎默认上限）。1000 步流程可编辑，但不能执行；这是有意的资源上限。
- 跨域 iframe 不支持；同源 iframe 的观察/动作在 Runner 中支持，扩展未实现 frame 定位。
- 定时触发在 Web 端由管理端手动/外部调度，Android 用 WorkManager（厂商可能限制）；不承诺永续后台运行。
