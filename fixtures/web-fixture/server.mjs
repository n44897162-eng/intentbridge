// IntentBridge web fixture server.
//
// This is acceptance infrastructure, not a demo: every drift variant is
// deterministic, and side-effect counts can be asserted from the API.
//
//   http://127.0.0.1:4317  the application under test
//   http://127.0.0.1:4318  a second origin (cross-origin iframe / scope tests)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.IB_FIXTURE_PORT ?? 4317);
const SECOND_ORIGIN_PORT = Number(process.env.IB_FIXTURE_SECOND_PORT ?? 4318);

const VARIANTS = new Set([
  'baseline',
  'renamed',
  'moved',
  'random-ids',
  'decoy',
  'visual',
  'slow',
  'shadow',
  'iframe',
  'external',
  'relabeled',
]);

const state = {
  variant: 'baseline',
  /** Monotonic counters used by tests to assert side effects. */
  searches: 0,
  submits: 0,
  detailOpens: 0,
  navigations: 0,
  variantChanges: 0,
  lastQuery: '',
  seed: 1,
  labelSuffix: Math.random().toString(36).slice(2, 8),
};

const CATALOG = [
  {
    id: 'r-1',
    title: 'Alpha 季度报告',
    body: '收入与留存分析，包含渠道拆解。',
    category: 'quarterly',
  },
  { id: 'r-2', title: 'Beta 客户画像', body: '高价值客户分层与生命周期。', category: 'portrait' },
  { id: 'r-3', title: 'Gamma 运营周报', body: '转化漏斗与实验结论汇总。', category: 'quarterly' },
  { id: 'r-4', title: 'Delta 数据质量', body: '缺失值、重复与延迟监控。', category: 'quality' },
  { id: 'r-5', title: 'Epsilon 摘要', body: '面向管理层的季度摘要。', category: 'quarterly' },
];

function normalizeVariant(value) {
  return VARIANTS.has(value) ? value : 'baseline';
}

function labelsFor(variant) {
  switch (variant) {
    case 'renamed':
      return {
        label: '查询',
        inputTestId: 'query-field',
        submitTestId: 'submit-query',
        resultTestId: 'result-entry',
        summaryTestId: 'result-summary',
        placeholder: '请输入查询词',
        inputId: 'query-field',
        submitId: 'submit-query',
        formId: 'query-form',
      };
    case 'relabeled':
      return {
        label: '搜索',
        inputTestId: 'keyword-field',
        submitTestId: 'search-submit-v2',
        resultTestId: 'result-entry',
        summaryTestId: 'results-summary-v2',
        placeholder: '输入关键词',
        inputId: 'keyword-field',
        submitId: 'search-submit-v2',
        formId: 'search-form-v2',
      };
    case 'random-ids': {
      const suffix = state.labelSuffix;
      return {
        label: '搜索',
        inputTestId: `field-${suffix}`,
        submitTestId: `submit-${suffix}`,
        resultTestId: `entry-${suffix}`,
        summaryTestId: `summary-${suffix}`,
        placeholder: '输入关键词',
        inputId: `field-${suffix}`,
        submitId: `submit-${suffix}`,
        formId: `form-${suffix}`,
      };
    }
    default:
      return {
        label: '搜索',
        inputTestId: 'keyword-input',
        submitTestId: 'search-submit',
        resultTestId: 'result-item',
        summaryTestId: 'results-summary',
        placeholder: '输入关键词',
        inputId: 'keyword',
        submitId: 'search-submit',
        formId: 'search-form',
      };
  }
}

function searchForm(variant, labels) {
  return `
    <form id="${labels.formId}" class="search" role="search" aria-label="搜索表单">
      <label for="${labels.inputId}">${labels.label}</label>
      <div class="search-row">
        <input id="${labels.inputId}" name="keyword" type="search"
               placeholder="${labels.placeholder}" aria-label="${labels.label}"
               data-testid="${labels.inputTestId}" autocomplete="off" />
        <button id="${labels.submitId}" type="submit" data-testid="${labels.submitTestId}">${labels.label}</button>
      </div>
      <div class="filters">
        <label for="report-type">报告类型
          <select id="report-type" data-testid="report-type" aria-label="报告类型">
            <option value="all">全部</option>
            <option value="quarterly">季度报告</option>
            <option value="portrait">客户画像</option>
            <option value="quality">数据质量</option>
          </select>
        </label>
        <label class="inline-check">
          <input type="checkbox" id="include-archived" data-testid="include-archived" aria-label="包含归档" />
          包含归档
        </label>
      </div>
      <p id="form-error" class="error" role="alert" data-testid="form-error" hidden></p>
    </form>`;
}

function toolbar(variant) {
  const decoy =
    variant === 'decoy'
      ? `<div class="toolbar"><button type="button" data-testid="search-submit-ghost" aria-label="搜索">搜索</button>
         <span class="hint">快速检索</span></div>`
      : '';
  const extra =
    variant === 'external'
      ? `<p class="hint"><a data-testid="external-link" href="http://127.0.0.1:${SECOND_ORIGIN_PORT}/external" rel="noreferrer">前往外部站点</a></p>`
      : '';
  return decoy + extra;
}

function shadowWidget() {
  return `
    <search-widget data-testid="shadow-host"></search-widget>
    <script>
      customElements.define('search-widget', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = \`
            <style>
              .box { display: flex; gap: 8px; align-items: center; margin: 16px 0; }
              input { padding: 8px 10px; border: 1px solid #c9d3e0; border-radius: 8px; }
              button { padding: 8px 14px; border: 0; border-radius: 8px; background: #2457d6; color: #fff; }
            </style>
            <div class="box" role="search" aria-label="组件内搜索">
              <input data-testid="shadow-input" aria-label="组件搜索" placeholder="组件内关键词" />
              <button data-testid="shadow-submit" aria-label="组件提交">提交</button>
            </div>
            <p data-testid="shadow-result" role="status" hidden></p>\`;
          const button = root.querySelector('button');
          const input = root.querySelector('input');
          button.addEventListener('click', () => {
            const result = root.querySelector('[data-testid="shadow-result"]');
            result.textContent = '已提交：' + (input?.value ?? '');
            result.hidden = false;
          });
        }
      });
    </script>`;
}

function iframes() {
  return `
    <section class="panel">
      <h2>嵌入表单</h2>
      <iframe id="same-origin-frame" title="同源表单" src="/frame.html" width="480" height="180"></iframe>
      <iframe id="cross-origin-frame" title="跨域表单" src="http://127.0.0.1:${SECOND_ORIGIN_PORT}/external-frame" width="480" height="180"></iframe>
    </section>`;
}

function bodyFor(variant) {
  const labels = labelsFor(variant);
  const form = searchForm(variant, labels);
  const formInSidebar = variant === 'moved';
  const showShadow = variant === 'shadow';
  const showIframes = variant === 'iframe';
  const visualShift = variant === 'visual';
  return `
  <header class="topbar">
    <a class="brand" href="/" data-nav-link>IntentBridge Fixture</a>
    <nav>
      <a href="/" data-nav-link data-testid="nav-home">首页</a>
      <a href="/reports" data-nav-link data-testid="nav-reports">报表</a>
    </nav>
  </header>
  <div class="layout ${visualShift ? 'shifted' : ''}">
    ${formInSidebar ? `<aside class="sidebar" aria-label="工具区">${toolbar(variant)}<h2 class="sidebar-title">筛选</h2>${form}</aside>` : ''}
    <main class="page" id="main">
      <section class="hero">
        <h1>客户报告检索</h1>
        <p>输入关键词，检索内部报告并查看摘要。所有数据均为本地夹具。</p>
        ${formInSidebar ? '' : form}
        ${toolbar(variant)}
      </section>
      ${showShadow ? shadowWidget() : ''}
      <section id="results-region" aria-live="polite">
        <p id="results-summary" role="status" data-testid="${labels.summaryTestId}" hidden></p>
        <ul id="results" class="results" data-testid="results-list"></ul>
        <button id="load-more" type="button" data-testid="load-more" class="ghost-button" hidden>加载更多</button>
      </section>
      ${showIframes ? iframes() : ''}
      <section id="reports-page" class="panel" data-testid="reports-page" hidden>
        <h2>报表中心</h2>
        <p>这里是通过 SPA 路由进入的报表页。</p>
        <button type="button" data-testid="reports-back">返回首页</button>
      </section>
    </main>
  </div>
  <div id="detail-dialog" class="dialog" role="dialog" aria-modal="true" aria-label="报告详情" data-testid="detail-dialog" hidden>
    <div class="dialog-card">
      <h2 id="detail-title">报告详情</h2>
      <p id="detail-body">这里是详情内容。</p>
      <button type="button" data-testid="close-detail">关闭</button>
    </div>
  </div>
  <footer class="footer" data-testid="footer">IntentBridge fixture · local only</footer>
  <script>window.__IB_VARIANT__ = ${JSON.stringify(variant)};</script>
  <script src="/app.js"></script>`;
}

function renderIndex() {
  const variant = state.variant;
  const labels = labelsFor(variant);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IntentBridge Fixture</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body data-variant="${variant}">
  <script>window.__IB_LABELS__ = ${JSON.stringify(labels)};</script>
  ${bodyFor(variant)}
</body>
</html>`;
}

function renderFrame() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>嵌入表单</title>
  <link rel="stylesheet" href="/styles.css"></head><body class="frame-body">
  <form id="frame-form" class="search">
    <label for="frame-keyword">嵌入搜索</label>
    <div class="search-row">
      <input id="frame-keyword" data-testid="frame-input" aria-label="嵌入搜索" placeholder="嵌入关键词" />
      <button type="submit" data-testid="frame-submit">提交</button>
    </div>
  </form>
  <p id="frame-result" data-testid="frame-result" hidden>已提交</p>
  <script>
    document.getElementById('frame-form').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('frame-result').hidden = false;
    });
  </script>
  </body></html>`;
}

function renderExternal() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>外部站点</title>
  <link rel="stylesheet" href="/styles.css"></head><body class="frame-body">
  <h1>外部站点（第二个 origin）</h1>
  <p>这个页面用于验证 app_scope 限制：流程不得越界操作。</p>
  <a href="http://127.0.0.1:${PORT}/" data-testid="back-to-app">返回应用</a>
  </body></html>`;
}

function renderExternalFrame() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>跨域嵌入</title>
  <link rel="stylesheet" href="/styles.css"></head><body class="frame-body">
  <p>跨域 iframe：内容脚本不得注入。</p>
  <input data-testid="cross-origin-input" aria-label="跨域输入" />
  </body></html>`;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 64 * 1024) {
      throw new Error('body too large');
    }
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const handler = async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`);
  try {
    if (url.pathname === '/__health') {
      return json(res, 200, { ok: true, variant: state.variant, port: PORT });
    }
    if (url.pathname === '/__config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.variant !== undefined) {
        state.variant = normalizeVariant(String(body.variant));
        state.variantChanges += 1;
        state.seed += 1;
        state.labelSuffix = Math.random().toString(36).slice(2, 8);
      }
      return json(res, 200, { ok: true, variant: state.variant });
    }
    if (url.pathname === '/__stats' && req.method === 'GET') {
      return json(res, 200, {
        variant: state.variant,
        searches: state.searches,
        submits: state.submits,
        detailOpens: state.detailOpens,
        navigations: state.navigations,
        variantChanges: state.variantChanges,
        lastQuery: state.lastQuery,
      });
    }
    if (url.pathname === '/__event' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.type === 'submit') state.submits += 1;
      if (body.type === 'detail') state.detailOpens += 1;
      if (body.type === 'navigate') state.navigations += 1;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      Object.assign(state, {
        variant: 'baseline',
        searches: 0,
        submits: 0,
        detailOpens: 0,
        navigations: 0,
        variantChanges: 0,
        lastQuery: '',
        labelSuffix: Math.random().toString(36).slice(2, 8),
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/search') {
      const query = (url.searchParams.get('q') ?? '').trim();
      state.searches += 1;
      state.lastQuery = query;
      const delay = state.variant === 'slow' ? 1800 : 120;
      const results = query
        ? CATALOG.filter((item) =>
            `${item.title} ${item.body}`.toLowerCase().includes(query.toLowerCase()),
          )
        : CATALOG.slice(0, 3);
      const matched =
        results.length > 0
          ? results
          : [{ id: 'echo', title: `关于“${query}”的结果`, body: '未命中目录，返回回显结果。' }];
      await new Promise((resolve) => setTimeout(resolve, delay));
      return json(res, 200, { query, count: matched.length, results: matched });
    }
    if (url.pathname === '/app.js') {
      return serveAsset(res, 'app.js', 'text/javascript; charset=utf-8');
    }
    if (url.pathname === '/styles.css') {
      return serveAsset(res, 'styles.css', 'text/css; charset=utf-8');
    }
    if (url.pathname === '/frame.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(renderFrame());
    }
    if (url.pathname === '/reports' || url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'SAMEORIGIN',
      });
      return res.end(renderIndex());
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (error) {
    json(res, 500, { ok: false, error: String(error) });
  }
};

async function serveAsset(res, name, contentType) {
  const body = await readFile(join(here, 'public', name));
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

const externalHandler = async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${SECOND_ORIGIN_PORT}`);
  if (url.pathname === '/external') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(renderExternal());
  }
  if (url.pathname === '/external-frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(renderExternalFrame());
  }
  if (url.pathname === '/styles.css') {
    return serveAsset(res, 'styles.css', 'text/css; charset=utf-8');
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
};

const server = http.createServer(handler);
const external = http.createServer(externalHandler);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fixture] app    http://127.0.0.1:${PORT}`);
});
external.listen(SECOND_ORIGIN_PORT, '127.0.0.1', () => {
  console.log(`[fixture] second http://127.0.0.1:${SECOND_ORIGIN_PORT}`);
});

function shutdown() {
  server.close();
  external.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
