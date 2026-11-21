# 安装与运行（Linux 验证环境）

## 依赖

- Node.js 22+（验证用 24.22.3）、pnpm 12.x、Rust 1.89（含 `wasm32-unknown-unknown` 目标）
- Chrome/Chromium（Runner 默认使用系统 Chrome；扩展实测使用 Playwright Chromium）
- Linux 桌面/ Xvfb（仅扩展测试需要）

```bash
rustup target add wasm32-unknown-unknown
pnpm install --frozen-lockfile
pnpm build
```

## 启动

```bash
# 终端 1：夹具
pnpm fixture:web

# 终端 2：管理端（打印带 token 的 URL）
IB_DATA_DIR=$PWD/.data IB_SHELL_PORT=4319 pnpm shell:web
```

数据目录结构（`IB_DATA_DIR`）：

```
.data/
  intentbridge.sqlite      # flows / revisions / runs / events / evidence / secrets(密文)
  evidence/                # 目标裁剪截图（默认 7 天）
  keystore/device.key      # Linux 开发密钥（0600，不是生产方案）
  backups/                 # 迁移/手动备份
```

## 升级

1. 停服务；
2. 备份 `.data`（或调用 `POST /api/maintenance/backup`）；
3. 拉取新版本、`pnpm install --frozen-lockfile && pnpm build`；
4. 启动时自动执行数据库迁移；迁移前自动写 `backups/`；
5. 打开 UI 检查流程 revision 与运行历史。

## 卸载

- 删除应用目录与 `IB_DATA_DIR` 即彻底移除本地数据（证据、日志、密钥、流程）。
- 扩展：chrome://extensions 移除；`chrome.storage.local` 中的流程随扩展移除。
- 不写入系统服务、不写入注册表（Windows 源码切片未安装）。

## 端口

- 4317/4318：Web 夹具 + 第二个 origin
- 4319：管理端（仅 127.0.0.1）

若端口被占用，用 `IB_FIXTURE_PORT`、`IB_FIXTURE_SECOND_PORT`、`IB_SHELL_PORT` 覆盖；流程 `app_scope` 必须同步更新（否则会被范围校验拒绝）。
