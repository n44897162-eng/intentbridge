# 崩溃与 OUTCOME_UNKNOWN 处理

## 原则

1. 引擎先写事件再执行下一个动作；崩溃后可以重建到最后一个已确认事件。
2. **写动作结果不明时绝不自动重放**。`OUTCOME_UNKNOWN` 是安全结果，不是失败要藏起来。
3. 人工判断必须有记录：选择“确认已成功 / 确认未成功 / 人工授权重试”都会进入诊断包。

## 运行崩溃

- 运行详情显示 `OUTCOME_UNKNOWN`；`RunPaused` 事件带 `reason: outcome_unknown`。
- 先查看目标应用/页面真实状态，再决定：
  - 确认已完成 → 结束本次运行并从下一步开始新运行（不要“继续”旧 attempt）；
  - 确认未完成 → 允许重试（有幂等键更安全）；
  - 不确定 → 停止，保留证据并人工处理。
- `GET /api/runs/:id/diagnostics` 导出脱敏包；证据在 `data/evidence` 下按 run 查询。

## 宿主崩溃

- 事件文件/数据库中的事件用于恢复；`Engine::recover` 校验 `(run_id, seq)`、返回终止状态或 `OUTCOME_UNKNOWN`。
- 不得复用旧 `action_attempt_id` 提交；重试必须新 attempt（引擎生成）。

## 数据库恢复

1. 停服务；
2. 选择 `data/backups/*.sqlite`；
3. 替换 `intentbridge.sqlite`（先复制当前文件留底）；
4. 启动，`GET /api/stats` 验证 schema_version 与计数。

## 证据缺失

证据写入失败不能导致宿主崩溃；但敏感动作缺少必需审计时引擎不得继续（由宿主上报 `EVIDENCE_WRITE_FAILED` 并暂停）。当前实现记录错误并继续非敏感步骤，敏感步骤的强制阻断列为 BUGLOG-006。
