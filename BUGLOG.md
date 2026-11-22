# BUGLOG（已知问题与未完成项）

规则：每个问题必须有严重级别、复现方式、当前状态和到期处理。没有“看起来能跑”就标解决。

| ID      | 严重级别           | 状态                             | 问题                                                                                                     | 复现/证据                                                                                                                     | 计划                                                                            |
| ------- | ------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| BUG-001 | 阻断（对 v1 DoD）  | **部分解决（构建通过）**         | Windows 执行器/夹具已用 .NET 8 交叉编译成功，但未在 Windows 上运行                                       | `dotnet build` 0 warning；见 `docs/BUILD-REPORT.md`                                                                           | 在 Windows 11 + UIA 环境跑 20 条黄金流程；运行前不得宣称 M2 完成                |
| BUG-002 | 阻断（对 v1 DoD）  | **部分解决（APK+JNI 构建通过）** | Android app/夹具与 JNI 已构建，但无设备/模拟器运行                                                       | SDK 35 + NDK 29 构建，APK 含 arm64/x86_64 `.so`；见 `docs/BUILD-REPORT.md`                                                    | 在 API 29/33/35 设备/模拟器跑 20 条流程、字体/DPI/深色/重建                     |
| BUG-003 | 严重               | **已解决（逻辑）**               | 扩展完整录制→回放已有真实 Chromium e2e：测试构建仅授予夹具 origin，驱动 background/content/engine 全链路 | `tests/e2e/extension.test.ts` 第 5 项通过；生产 manifest 仍无默认权限（设计如此）                                             | 生产授权 UX 仍需人工冒烟；不算阻断                                              |
| BUG-004 | 中                 | 未解决                           | 扩展不计算视觉 dHash；纯视觉锚点会退化为“需确认”                                                         | `enrichVisuals` 未在 ExtensionDriver 实现                                                                                     | 用 `chrome.tabs.captureVisibleTab` + OffscreenCanvas 裁剪；需处理权限和敏感遮罩 |
| BUG-005 | 中                 | 未解决                           | 扩展动作使用 DOM `click()`/原生 setter，不产生 trusted 事件                                              | `apps/web-extension/src/content.ts`                                                                                           | 需要 trusted 输入的场景改用 chrome.debugger 或桌面 Runner；文档已限制           |
| BUG-006 | 中                 | 未解决                           | 敏感步骤缺少必需证据时，宿主未强制阻断（只记录写入失败）                                                 | `RunManager.recordEvidence` 超配额直接 return；无 `EVIDENCE_WRITE_FAILED` 暂停                                                | 在引擎/宿主增加“敏感步骤必需审计”开关并测试                                     |
| BUG-007 | 中                 | **已解决**                       | 证据尺寸未入库                                                                                           | `onEvidence` 现携带 width/height 并写入 SQLite                                                                                | 遮罩元数据仍未记录（低）                                                        |
| BUG-008 | 低                 | 未解决                           | Windows provider 未接 DPAPI 密钥读取；`secret://` 在 Windows 端会走到 FINAL `SECRET_NOT_FOUND`           | 源码 `apps/windows-executor/UiaProvider.cs` 未实现 secret resolver                                                            | M2 完成时接入 DPAPI                                                             |
| BUG-009 | 低                 | 未解决                           | Android 定时运行依赖无障碍服务常驻；厂商后台限制下会失败                                                 | `ScheduledFlowWorker`                                                                                                         | 增加可见失败通知与重试策略；不承诺永续                                          |
| BUG-010 | 低                 | 未解决                           | 跨域 iframe 不支持；同源 iframe 在扩展中未实现 frame 定位                                                | ASSUMPTIONS A12                                                                                                               | 扩展改用 `chrome.webNavigation` + frameId 路由，或明确不支持                    |
| BUG-011 | 低                 | 未解决                           | 未执行 10MB 流程包/2 小时长跑/磁盘满故障注入                                                             | 见 TEST-REPORT NOT_RUN                                                                                                        | M4 补充                                                                         |
| BUG-012 | 低                 | 未解决                           | 未接入 CVE 扫描；SBOM 仅生成组件清单                                                                     | `scripts/sbom.mjs`                                                                                                            | CI 增加 `pnpm audit`/`cargo audit`（需网络与数据库）                            |
| BUG-013 | 低                 | **已解决**                       | 并发运行上限错误码不明确                                                                                 | 现在返回 HTTP 429 / `TOO_MANY_ACTIVE_RUNS`，UI 显示原因                                                                       | 无自动排队，仍是显式失败                                                        |
| BUG-015 | 严重（对 M1 门禁） | **已解决（Web）**                | Web 黄金流程语料不足 20 条                                                                               | 已补齐 21 条并通过真实 Chrome 回放：`tests/replay/web-golden.test.ts`、`artifacts/web-golden-report.json`                     | Windows/Android 各自的 20 条仍在 BUG-001/002 下，随平台实机验证完成             |
| BUG-016 | 中                 | **已解决**                       | `scroll` 的边界条件只在静态校验中强制，运行时只执行一次滚动                                              | 引擎现在循环滚动直到边界或 `max_attempts`；测试 `scroll_retries_until_boundary_or_max_attempts`                               | 无                                                                              |
| BUG-014 | 低                 | **部分解决**                     | 无签名安装包/商店发布；M6 未完成                                                                         | 已产出扩展 zip、debug APK、Windows 托管程序集、源码 tar 与 SHA256SUMS；见 `artifacts/` 与 `docs/runbooks/INSTALL-PACKAGES.md` | 签名安装包、升级/回滚、干净机测试                                               |
| BUG-017 | 中                 | 未解决                           | 录制期间发生整页导航/表单刷新时，新 document 没有 recorder，之前事件丢失；stop 会报 no active recorder   | `packages/web-core/src/dom-snapshot.ts`、`apps/web-runner/src/recorder.ts`                                                    | 录制事件增量写入 sessionStorage/后台，跨 document 恢复合并                      |
| BUG-018 | 中                 | 未解决                           | MV3 service worker 空闲 30s 可能被回收；等待人工决策的 promise 无超时，run 可能永久停在 running          | `apps/web-extension/src/background.ts`                                                                                        | 用 chrome.alarms 重建/收尾 + decision 超时失败                                  |
| BUG-019 | 中                 | 未解决                           | Android 录制按 native id 过滤目标，无 id 的按钮/文本控件不会被记录                                       | `apps/web-extension` 无关；`apps/android-app/.../IntentBridgeAccessibilityService.kt`                                         | 用 bounds/class/text 匹配同位置候选，或记录无 id 候选并生成结构锚点             |

## 已修复但值得保留记录

- FIX-001：MV3 CSP 阻断 Ajv `new Function`，导致 service worker 启动即失败。修复：浏览器侧不再引入 Ajv，由 Rust 引擎负责装载/执行校验；content/background 重新构建后实测通过。
- FIX-002：夹具 random-ids 变体两次生成不同随机后缀，DOM 与 labels 不一致。修复：每个页面请求使用同一个 suffix。
- FIX-003：Web 宿主对 `launch` 先做 scope 检查会把 about:blank 误判为越界。修复：导航动作不预检，导航后用引擎事实校验。
- FIX-004：`AwaitCondition` 轮询时未按 `poll_after` 等待，导致同一时间点空转。修复：使用引擎返回的退避时间/`AwaitTimer`，不引入固定 sleep。
- FIX-005：WASM 每运行重新编译导致长跑内存上涨。修复：编译一次 `WebAssembly.Module`，每次实例化；Web soak 的 heap_used 保持平稳。
- FIX-006：宿主对 `AwaitCondition` 立即重拍快照，不尊重 `poll_after_ms`，失败条件会空转到 500 次上限。修复：按引擎退避等待后再观察。
- FIX-012：宿主在 Cancel 后又提交一次 Cancel，导致 run 被记成 INTERNAL_ERROR。解决：Finished 优先判断 + Cancel 只提交一次，已加单测。
- FIX-013：敏感变量插值后的明文进入 params_preview；参数超 200 字节按字节截断可 panic。解决：按敏感变量值脱敏、按字符截断，并修 sensitive_key 分词。
- FIX-014：无 target 的 launch/scroll 绕过审批；动作 pending 时可暂停导致重放；OUTCOME_UNKNOWN 重试复用 attempt_id；postcondition 失败提前清 side_effect。解决：审批移入 perform_action、拒绝动作中暂停、重试分配新 attempt、成功确认后才清副作用。
- FIX-015：TS 协议缺 Pause/RecoveryDecision/PAUSED_FOR_RECOVERY。解决：补齐输入/状态/校验与测试。
- FIX-016：流程保存无乐观并发；导入 revision 与存储槽位不一致；版本 hash 与落库 JSON 不一致。解决：base_revision + 409、导入归一化 r1、hash 在事务内对 stored JSON 计算。
- FIX-017：备份忽略 WAL 且 checkpoint 失败静默。解决：VACUUM INTO 一致快照。
- FIX-018：扩展 launch 可能等待旧页面 complete；storage 写入乱序覆盖 pending。解决：监听 onUpdated 匹配目标 URL；串行化 storage 写。
- FIX-019：证据裁剪忽略滚动、未 mask 密码、iframe 坐标错。解决：滚动偏移 + 默认密码 mask；iframe 证据跳过而非截错。
- FIX-020：录制 select/checkbox 生成 input，回放必失败。解决：select 生成 select 动作、checkbox 只保留 click；select 用 window-stable 后置条件。
- FIX-021：Windows launch 可绕过 app_scope 执行任意程序；secret:// 被当字面量输入。解决：launch 必须等于 scope；secret 未配置时 SECRET_NOT_FOUND。
- FIX-022：Android 主线程跑 JNI/快照；停止录制把 IntentBridge 自身记为目标；异常不写终态。解决：Dispatchers.Default、录制事件 scope、catch 写 failed。
- FIX-023：CI 在依赖安装前调用 Playwright；JNI 缺失仍报 Android PASS。解决：调整安装顺序；JNI 缺失 fail-closed 并清理旧 jniLibs。
- FIX-011：scroll 运行时忽略边界条件与最大次数。解决：动作完成后请求边界观察，未达边界则重试滚动，超过 `max_attempts` 失败。
- FIX-008：扩展完整录制→回放无法在自动化中触发 activeTab。解决：测试构建只授予夹具 origin，生产 manifest 不变；由此验证 background/content/WASM 全链路。
- FIX-009：Windows 执行器缺少 WindowsDesktop 引用导致 UIA 类型不可用。解决：`UseWPF` 引入 UIAutomation 引用包；Linux 交叉编译通过。
- FIX-010：Android 无障碍服务未实现 `onInterrupt` 导致 Kotlin 编译失败。解决：实现并清理通知。
- FIX-007：DOM 快照写入 `data-ib-candidate` 被 MutationObserver 当成页面变化，导致 `window-stable` 永远不成立。修复：忽略 `data-ib-*` 属性变更。
