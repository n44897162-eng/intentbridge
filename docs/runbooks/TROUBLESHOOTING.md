# 故障排查

| 现象             | 错误码                                     | 排查                                                                        |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| 导入被拒         | `INVALID_IR`                               | UI 会列 rule/path；重点看后置条件、权限、app_scope、未声明模板              |
| 目标反复找不到   | `TARGET_NOT_FOUND`                         | 用「目标检查器」看最近候选评分；检查 origin/包名/窗口是否变化；必要时改锚点 |
| 候选分数接近     | `TARGET_AMBIGUOUS`                         | 在运行详情里选择正确候选；保存后产生新 revision                             |
| 元素已失效       | `STALE_TARGET`                             | 页面/窗口重建；引擎会重新解析；若持续，检查是否跨页面/弹窗                  |
| 离开应用范围     | `APP_SCOPE_VIOLATION`                      | 导航到非白名单 origin 或切到别的 App；流程会暂停，不会继续点击              |
| 权限不足         | `PERMISSION_DENIED`                        | 流程 `permissions` 缺少动作所需能力；重新编辑并保存                         |
| 等待条件超时     | `TIMEOUT` / `PRECONDITION_FAILED`          | 提高 timeout（上限 120s）或修正条件；检查网络/懒加载                        |
| 写后置条件不成立 | `POSTCONDITION_FAILED` / `OUTCOME_UNKNOWN` | 先人工确认真实结果，见 RECOVERY.md                                          |
| 动作重复风险     | `OUTCOME_UNKNOWN`                          | 不要盲目重试；声明幂等键或人工确认                                          |
| IPC 401/403      | `IPC_UNAUTHORIZED`                         | 使用带 token 的 URL；跨站请求会被拒绝                                       |
| 解密失败         | `DECRYPT_FAILED`                           | 口令错误或包被篡改；scrypt 参数/格式必须完整                                |
| 运行被占用       | `TOO_MANY_ACTIVE_RUNS`                     | 管理端最多 2 个并发浏览器运行；等待或取消                                   |
| 扩展录制不了     | `TARGET_NOT_FOUND`/无响应                  | 先在弹出页「授权当前站点」；确认当前 tab 不是 chrome://                     |

## Runner 无头运行

```bash
node apps/web-runner/dist/cli.js run --flow flow.json --variables keyword=报告 \
  --headless --evidence artifacts/evidence --out artifacts/run.json
```

失败时退出码 2，并在 JSON 中给出 `error.code`、`action_log`、`pending.kind`。

## 测试不稳定

- 禁止“重跑直到绿”。先保留失败日志/证据，再定位。
- 已知跨平台/显示相关测试（扩展）在无 X11 环境会 skip，不是失败；在 CI 用 `xvfb-run`。
