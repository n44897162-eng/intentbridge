# 测试报告（2026-11-22）

## 环境

- Linux x86_64，4 vCPU / 3.6 GiB RAM（含 swap）；Xvnc `:1` 供有头 Chromium 使用。
- Node.js 24.22.3、pnpm 12.21.0、TypeScript 5.9.3、Vitest 2.1.9。
- Rust 1.89.0（`x86_64-unknown-linux-gnu` + `wasm32-unknown-unknown`）。
- 真实浏览器：Playwright Chromium 159.0.8154.6（扩展必须用未禁用 `--load-extension` 的 Chromium；系统 Google Chrome 已禁用该参数）。
- 夹具服务：`fixtures/web-fixture`，127.0.0.1:4317/4318。

## 结果总览

| 套件                               | 结果     | 数量                                         |
| ---------------------------------- | -------- | -------------------------------------------- |
| Rust 单元 + 集成（anchor/runtime） | 通过     | 5 + 4                                        |
| Rust 引擎状态机测试                | 通过     | 26                                           |
| 三端一致性（虚拟 Provider）        | 通过     | 5                                            |
| Rust 500 次长跑                    | 通过     | 1                                            |
| TS 单元（IR/协议/WASM/属性测试）   | 通过     | 19 + 11 + 2                                  |
| Web 黄金回放（真实 Chrome）        | 通过     | 4（含 10 次连续回放、录制→回放、越界暂停）   |
| 漂移语料                           | 通过     | 1 组 9 例（7/7 可恢复，误执行 0）            |
| 管理端 API                         | 通过     | 10                                           |
| SQLite 备份/恢复                   | 通过     | 1                                            |
| 管理端 UI（真实浏览器）            | 通过     | 3（含暂停决策、证据、1000 步 143ms）         |
| MV3 扩展（真实 Chromium）          | 通过     | 4（加载/清单/WASM/popup/content 快照与输入） |
| TS↔Rust IR 校验一致性              | 通过     | 3                                            |
| Web 30 次长跑                      | 通过     | 1                                            |
| **合计**                           | **全绿** | **41 Rust + 59 TS**                          |

运行命令：`pnpm gate`（锁文件、类型、rustfmt、clippy -D warnings、cargo test、release/WASM 构建、全部 TS 测试、lint、格式、SBOM）。

## 关键验收证据

### Web 端到端

- 真实 Chrome 打开夹具 → 输入 → 点击 → 读取摘要 → 断言 → 成功；副作用计数 `submits=1`。
- 连续 10 次回放，`submits=10`，无失败。
- 录制：Playwright 作为“用户”完成输入/点击，录制器产出 IR，校验通过，再次回放成功。
- 越界：流程点击外部链接跳到第二个 origin，引擎在 ActionDone 事实中发现越界并暂停；外部站点未发生搜索提交。

### 漂移重锚（`artifacts/drift-report.json`）

- 9 例：baseline、moved、visual、slow、relabeled、random-ids、decoy、renamed（两种流程）。
- 可恢复 7 例全部成功（自动或人工确认后），`success_rate=1.0`。
- `mis_executions=0`；所有“拒绝”用例都没有执行任何 click/input。
- renamed 用例无可信证据 → 拒绝执行，属于正确行为（不是失败）。

### 长跑与内存

- Rust 虚拟源 500 次运行：RSS 6376→6396 KiB（+20 KiB），事件序列无缺口。
- Web 真实 Chrome 30 次：全部成功；Node live heap 62.9→61.7 MiB（平稳）；RSS 因 V8 预留页增长，属于分配器行为，不是对象泄漏。总耗时 P95 654 ms（含真实浏览器动作）。
- Planner 开销：40 个样本，P95 1.45 ms（预算 <100 ms），见 `artifacts/web-perf.json`。

### 管理端

- API：导入/版本/导出/加密导出、错误口令、诊断脱敏、密钥只回别名、设置校验、证据路径穿越 403、空录制拒绝、备份、执行级校验。
- UI：真实浏览器保存 r2、试运行到 SUCCEEDED、暂停→候选→继续→证据图片可读；1000 步流程从导航到 1000 行可见 143 ms（多次运行 139–238 ms）。

## NOT_RUN（明确未验证）

| 项目                                               | 原因                                           | 复现/到期                                  |
| -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Windows 执行器/夹具构建与运行                      | 本机无 Windows/.NET                            | `apps/windows-executor/README.md`；BUG-001 |
| Android app/夹具/Gradle/JNI                        | 本机无 Android SDK/模拟器                      | `apps/android-app/README.md`；BUG-002      |
| 扩展完整工具栏录制→回放                            | 需要真实用户手势授予 activeTab/host permission | BUG-003；人工测试脚本待补                  |
| 10MB 流程包 UI 卡死                                | 未构造 10MB 包；Schema 上限 1MB/1000 步已实现  | BUG-011                                    |
| 2 小时连续长跑                                     | 仅 500 虚拟 + 30 真实 Chrome                   | BUG-011                                    |
| 磁盘满/权限运行时撤销                              | 未注入                                         | BUG-006                                    |
| Windows/Android 真实故障注入（进程 kill/窗口重建） | 平台不可用                                     | BUG-001/002                                |

## 稳定性与 flaky

- 本报告中的结果来自 `pnpm gate` 的连续执行；没有“重跑直到绿”。
- 扩展测试依赖 X11；无显示时 `describe.skipIf` 跳过并在输出中可见。CI 使用 xvfb-run。
- 未观察到随机失败；漂移/回放语料均为确定性夹具。

## 证据文件

- `artifacts/drift-report.json`
- `artifacts/web-soak.json`
- `artifacts/web-perf.json`
- `artifacts/shell-flows.png`、`artifacts/shell-editor.png`（人工检查用截图）
- `sbom/intentbridge-sbom.json`
