# ADR-0002: 本地管理端、UI 技术栈与开发密钥适配器

状态：接受（2026-01）

## 决策

1. 管理端是本地 Node 服务（`apps/web-shell`），只监听 loopback，启动生成一次性 token；UI 通过带 token 的 URL 打开，API 同时校验 token 与跨站来源。
2. UI 使用无框架 DOM + esbuild 打包（`packages/editor-ui`）。原因：P0 页面以表格/表单/时间轴为主，引入 React 会显著增加安装体积与内存；共享组件仍是独立包，未来 Tauri/WebView2 壳可直接复用。
3. 数据库使用 Node 24 内置 `node:sqlite`，避免原生编译依赖（本机 4G 内存，better-sqlite3 编译成本高）。锁文件固定 Node 24 行为。
4. 密钥：平台生产适配器是 Keystore/DPAPI，浏览器是 `chrome.storage.session`；Linux 验证环境用 AES-256-GCM + 0600 设备密钥文件的开发适配器，接口相同。数据库只存密文。
5. 加密流程包：scrypt(N=16384,r=8,p=1) + AES-256-GCM，口令不落盘；导出文件不含私钥或明文密钥值。
6. Windows 桌面壳（Tauri/WebView2）未在本环境实现；浏览器管理端承担 P0 的流程/运行/证据视图。此偏离记录在 ASSUMPTIONS A5，恢复路径是新增一个加载 loopback URL 的 Tauri 壳，不需要改协议。

## 后果

- 依赖少、可离线、启动快；1000 步流程在真实浏览器中 167–238ms 打开。
- 没有前端框架的组件生态；复杂交互需自己写。P0 范围可接受。
- `node:sqlite` 在测试中需要 Vite alias 到原生模块（`tests/shims/sqlite.ts`），属于构建工具兼容层，不进入生产 bundle。
