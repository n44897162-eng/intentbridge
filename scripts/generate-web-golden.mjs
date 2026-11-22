// Generates the Web golden-flow corpus. Every flow is validated by action-ir
// before it is written, so the corpus can never drift into invalid IR.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFlow } from '../core/action-ir/dist/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'fixtures/flows/web-golden');
mkdirSync(OUT, { recursive: true });
mkdirSync(resolve(ROOT, 'tests/replay'), { recursive: true });
const WEB = 'http://127.0.0.1:4317';
const PERMISSIONS = [
  'read-ui',
  'read-screen',
  'click',
  'type',
  'select',
  'scroll',
  'launch',
  'navigate',
];

const target = (anchors) => ({ anchors, confidence: { mode: 'balanced' } });
const T = {
  input: target({
    semantic: {
      role: 'textbox',
      name: '搜索',
      placeholder: '输入关键词',
      test_id: 'keyword-input',
    },
    native_identity: { kind: 'web-test-id', value: 'keyword-input' },
    structure: { path: ['main.page', 'form#search-form', 'input#keyword'] },
    visual: {
      norm_rect: { x: 0.18, y: 0.2, w: 0.42, h: 0.05 },
      viewport: { w: 1280, h: 800 },
      device_scale: 1,
    },
  }),
  submit: target({
    semantic: { role: 'button', name: '搜索', test_id: 'search-submit' },
    native_identity: { kind: 'web-test-id', value: 'search-submit' },
    structure: { path: ['main.page', 'form#search-form', 'button#search-submit'] },
  }),
  summary: target({
    semantic: { role: 'status', test_id: 'results-summary' },
    native_identity: { kind: 'web-test-id', value: 'results-summary' },
    structure: { path: ['main.page', 'section#results-region', 'p#results-summary'] },
  }),
  formError: target({
    semantic: { role: 'alert', test_id: 'form-error' },
    native_identity: { kind: 'web-test-id', value: 'form-error' },
  }),
  reportsPage: target({
    native_identity: { kind: 'web-test-id', value: 'reports-page' },
    structure: { path: ['main.page', 'section#reports-page'] },
  }),
  navReports: target({
    semantic: { role: 'link', name: '报表', test_id: 'nav-reports' },
    native_identity: { kind: 'web-test-id', value: 'nav-reports' },
  }),
  reportsBack: target({
    semantic: { role: 'button', name: '返回首页', test_id: 'reports-back' },
    native_identity: { kind: 'web-test-id', value: 'reports-back' },
  }),
  dialog: target({
    semantic: { role: 'dialog', name: '报告详情', test_id: 'detail-dialog' },
    native_identity: { kind: 'web-test-id', value: 'detail-dialog' },
  }),
  closeDialog: target({
    semantic: { role: 'button', name: '关闭', test_id: 'close-detail' },
    native_identity: { kind: 'web-test-id', value: 'close-detail' },
  }),
  openFirst: target({
    semantic: { role: 'button', name: '查看详情', test_id: 'open-detail-1' },
    native_identity: { kind: 'web-test-id', value: 'open-detail-1' },
  }),
  loadMore: target({
    semantic: { role: 'button', name: '加载更多', test_id: 'load-more' },
    native_identity: { kind: 'web-test-id', value: 'load-more' },
  }),
  footer: target({
    native_identity: { kind: 'web-test-id', value: 'footer' },
  }),
  reportType: target({
    semantic: { role: 'combobox', name: '报告类型', test_id: 'report-type' },
    native_identity: { kind: 'web-test-id', value: 'report-type' },
    structure: { path: ['main.page', 'form#search-form', 'div.filters', 'select#report-type'] },
  }),
  includeArchived: target({
    semantic: { role: 'checkbox', name: '包含归档', test_id: 'include-archived' },
    native_identity: { kind: 'web-test-id', value: 'include-archived' },
    structure: { path: ['main.page', 'form#search-form', 'div.filters', 'input#include-archived'] },
  }),
  shadowInput: target({
    semantic: { role: 'textbox', name: '组件搜索', test_id: 'shadow-input' },
    native_identity: { kind: 'web-test-id', value: 'shadow-input' },
  }),
  shadowSubmit: target({
    semantic: { role: 'button', name: '组件提交', test_id: 'shadow-submit' },
    native_identity: { kind: 'web-test-id', value: 'shadow-submit' },
  }),
  shadowResult: target({
    semantic: { role: 'status', test_id: 'shadow-result' },
    native_identity: { kind: 'web-test-id', value: 'shadow-result' },
  }),
  frameInput: target({
    semantic: { role: 'textbox', name: '嵌入搜索', test_id: 'frame-input' },
    native_identity: { kind: 'web-test-id', value: 'frame-input' },
  }),
  frameSubmit: target({
    semantic: { role: 'button', name: '提交', test_id: 'frame-submit' },
    native_identity: { kind: 'web-test-id', value: 'frame-submit' },
  }),
  frameResult: target({
    native_identity: { kind: 'web-test-id', value: 'frame-result' },
  }),
};

const present = (t) => ({ kind: 'element-present', target: t });
const absent = (t) => ({ kind: 'element-absent', target: t });
const text = (t, value, extra = {}) => ({
  kind: 'text-matches',
  target: t,
  matcher: { type: 'contains', value, case_sensitive: false, ...extra },
});
const stable = (ms = 100) => ({ kind: 'window-stable', min_stable_ms: ms });
const varCompare = (variable, operator, value) => ({
  kind: 'variable-compare',
  variable,
  operator,
  value,
});

function makeFlow(index, name, variables, steps, description = '') {
  return {
    schema_version: '1.0.0',
    flow_id:
      `a1${String(index).padStart(6, '0')}-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`.slice(
        0,
        36,
      ),
    name,
    description,
    platform: 'web',
    app_scope: { kind: 'web-origin', value: WEB },
    variables,
    permissions: PERMISSIONS,
    steps,
    created_by: 'fixture-web',
    revision: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: { suite: 'web-golden' },
    defaults: {
      evidence_policy: {
        capture: 'target',
        save_on: 'failure',
        retention_days: 7,
        mask_text: true,
      },
    },
  };
}

const launch = (post = present(T.input)) => ({
  id: 'open',
  action: 'launch',
  name: '打开搜索页',
  risk: 'normal',
  postconditions: [post],
  params: { app_id: WEB, url: `${WEB}/`, wait_ready: true },
});
const input = (value = '${keyword}', post = present(T.summary), id = 'type-keyword') => ({
  id,
  action: 'input',
  name: '输入关键词',
  risk: 'normal',
  target: T.input,
  postconditions: [post],
  params: { value, clear_first: true },
});
const submit = (post = present(T.summary), id = 'submit') => ({
  id,
  action: 'click',
  name: '提交搜索',
  risk: 'normal',
  target: T.submit,
  // The fixture may re-render asynchronously; require the page to settle so a
  // subsequent result-row click cannot race a DOM replacement.
  postconditions: [post, stable(250)],
  params: { button: 'left', click_count: 1 },
});
const readSummary = (variable = 'summary') => ({
  id: `read-${variable}`,
  action: 'read-text',
  name: '读取摘要',
  risk: 'normal',
  target: T.summary,
  params: { output_variable: variable, max_chars: 300 },
});
const end = { id: 'done', action: 'end', name: '完成', params: { status: 'success' } };
const keywordVar = [{ name: 'keyword', type: 'string', required: true }];

const flows = [];
const add = (index, name, variables, steps, description = '', meta = {}) => {
  flows.push({
    file: `golden-${String(index).padStart(2, '0')}`,
    flow: makeFlow(index, name, variables, steps, description),
    meta,
  });
};

add(
  1,
  '搜索并断言结果',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    readSummary(),
    {
      id: 'assert-keyword',
      action: 'assert',
      name: '摘要包含关键词',
      params: { condition: text(T.summary, '${keyword}'), message: '摘要应包含搜索词' },
    },
    end,
  ],
  '最小黄金路径：打开、输入、提交、读取、断言。',
);

add(
  2,
  '空关键词显示校验错误',
  keywordVar,
  [
    launch(),
    {
      id: 'submit-empty',
      action: 'click',
      name: '空提交',
      risk: 'normal',
      target: T.submit,
      postconditions: [text(T.formError, '请输入关键词')],
      params: { button: 'left', click_count: 1 },
    },
    {
      id: 'assert-error',
      action: 'assert',
      name: '错误可见',
      params: { condition: present(T.formError) },
    },
    end,
  ],
  '表单校验错误必须由可观察条件证明。',
);

add(
  3,
  '打开并关闭详情弹窗',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    {
      id: 'open-detail',
      action: 'click',
      name: '打开详情',
      risk: 'normal',
      target: T.openFirst,
      postconditions: [present(T.dialog)],
      params: { button: 'left' },
    },
    {
      id: 'assert-dialog',
      action: 'assert',
      name: '弹窗出现',
      params: { condition: present(T.dialog) },
    },
    {
      id: 'close-detail',
      action: 'click',
      name: '关闭详情',
      risk: 'normal',
      target: T.closeDialog,
      postconditions: [absent(T.dialog)],
      params: { button: 'left' },
    },
    end,
  ],
  '弹窗打开/关闭 + 唯一结果按钮原生 id。',
);

add(
  4,
  'SPA 报表路由与返回',
  keywordVar,
  [
    launch(),
    {
      id: 'go-reports',
      action: 'click',
      name: '进入报表',
      risk: 'normal',
      target: T.navReports,
      postconditions: [present(T.reportsPage)],
      params: { button: 'left' },
    },
    {
      id: 'back-home',
      action: 'click',
      name: '返回首页',
      risk: 'normal',
      target: T.reportsBack,
      postconditions: [present(T.input)],
      params: { button: 'left' },
    },
    {
      id: 'assert-home',
      action: 'assert',
      name: '回到搜索页',
      params: { condition: present(T.input) },
    },
    end,
  ],
  'SPA pushState 路由，不整页刷新。',
);

add(
  5,
  '加载更多并滚动',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    {
      id: 'load-more-1',
      action: 'click',
      name: '加载更多',
      risk: 'normal',
      target: T.loadMore,
      postconditions: [text(T.summary, '已加载')],
      params: { button: 'left' },
    },
    {
      id: 'scroll-down',
      action: 'scroll',
      name: '向下滚动',
      risk: 'normal',
      target: null,
      postconditions: [stable(100)],
      params: {
        direction: 'down',
        amount: 350,
        max_attempts: 3,
        boundary_condition: present(T.footer),
      },
    },
    {
      id: 'load-more-2',
      action: 'click',
      name: '再次加载',
      risk: 'normal',
      target: T.loadMore,
      postconditions: [text(T.summary, '已加载')],
      params: { button: 'left' },
    },
    end,
  ],
  '懒加载列表 + 有边界与最大次数的滚动。',
);

add(
  6,
  'Shadow DOM 输入与提交',
  keywordVar,
  [
    launch(),
    input('${keyword}', stable(120)),
    {
      id: 'shadow-type',
      action: 'input',
      name: '组件内输入',
      risk: 'normal',
      target: T.shadowInput,
      postconditions: [stable(100)],
      params: { value: '${keyword}', clear_first: true },
    },
    {
      id: 'shadow-submit',
      action: 'click',
      name: '组件内提交',
      risk: 'normal',
      target: T.shadowSubmit,
      postconditions: [text(T.shadowResult, '${keyword}')],
      params: { button: 'left' },
    },
    {
      id: 'assert-shadow',
      action: 'assert',
      name: '组件结果可见',
      params: { condition: present(T.shadowResult) },
    },
    end,
  ],
  '开放 Shadow DOM 目标解析与动作。',
  { variant: 'shadow' },
);

add(
  7,
  '同源 iframe 表单',
  keywordVar,
  [
    launch(),
    input('${keyword}', stable(120)),
    {
      id: 'frame-type',
      action: 'input',
      name: 'iframe 内输入',
      risk: 'normal',
      target: T.frameInput,
      postconditions: [stable(100)],
      params: { value: '${keyword}', clear_first: true },
    },
    {
      id: 'frame-submit',
      action: 'click',
      name: 'iframe 内提交',
      risk: 'normal',
      target: T.frameSubmit,
      postconditions: [text(T.frameResult, '已提交')],
      params: { button: 'left' },
    },
    {
      id: 'assert-frame',
      action: 'assert',
      name: 'iframe 结果可见',
      params: { condition: present(T.frameResult) },
    },
    end,
  ],
  '同源 iframe 的候选快照、帧内定位与动作。',
  { variant: 'iframe' },
);

add(
  8,
  '按报告类型筛选',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    {
      id: 'select-type',
      action: 'select',
      name: '选择客户画像',
      risk: 'normal',
      target: T.reportType,
      postconditions: [text(T.summary, '筛选：客户画像')],
      params: { value: 'portrait', by: 'value' },
    },
    {
      id: 'assert-filter',
      action: 'assert',
      name: '筛选摘要',
      params: { condition: text(T.summary, '客户画像') },
    },
    end,
  ],
  'select 动作 + 筛选后的可观察摘要。',
);

add(
  9,
  '包含归档开关',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    {
      id: 'toggle-archive',
      action: 'click',
      name: '包含归档',
      risk: 'normal',
      target: T.includeArchived,
      postconditions: [text(T.summary, '含归档')],
      params: { button: 'left' },
    },
    {
      id: 'assert-archive',
      action: 'assert',
      name: '摘要含归档',
      params: { condition: text(T.summary, '含归档') },
    },
    end,
  ],
  'checkbox 点击 + 列表更新。',
);

add(
  10,
  '回车提交搜索',
  keywordVar,
  [
    launch(),
    {
      id: 'type-enter',
      action: 'input',
      name: '输入并回车',
      risk: 'normal',
      target: T.input,
      postconditions: [present(T.summary)],
      params: { value: '${keyword}', clear_first: true, submit: true },
    },
    {
      id: 'assert-enter',
      action: 'assert',
      name: '回车后摘要含关键词',
      params: { condition: text(T.summary, '${keyword}') },
    },
    end,
  ],
  '键盘 Enter 提交，验证 input.submit。',
);

add(
  11,
  '连续两次搜索',
  [
    { name: 'keyword1', type: 'string', required: true },
    { name: 'keyword2', type: 'string', required: true },
  ],
  [
    launch(),
    input('${keyword1}', present(T.summary), 'type-1'),
    submit(present(T.summary), 'submit-1'),
    readSummary('first'),
    {
      id: 'assert-first',
      action: 'assert',
      name: '第一次结果',
      params: { condition: text(T.summary, '${keyword1}') },
    },
    input('${keyword2}', present(T.summary), 'type-2'),
    submit(text(T.summary, '${keyword2}'), 'submit-2'),
    readSummary('second'),
    {
      id: 'assert-second',
      action: 'assert',
      name: '第二次结果',
      params: { condition: text(T.summary, '${keyword2}') },
    },
    end,
  ],
  '变量驱动两次独立搜索。',
);

add(
  12,
  '分支进入详情',
  [
    { name: 'keyword', type: 'string', required: true },
    { name: 'mode', type: 'string', required: true },
  ],
  [
    launch(),
    input(),
    submit(),
    {
      id: 'branch',
      action: 'branch',
      name: '是否查看详情',
      params: {
        condition: varCompare('mode', 'equals', 'detail'),
        goto_step_id: 'open-detail',
        else_step_id: 'done',
      },
    },
    {
      id: 'open-detail',
      action: 'click',
      name: '打开详情',
      risk: 'normal',
      target: T.openFirst,
      postconditions: [present(T.dialog)],
      params: { button: 'left' },
    },
    end,
  ],
  'branch 基于变量选择路径；默认变量为 detail。',
);

add(
  13,
  'set-variable 与输出断言',
  [
    { name: 'keyword', type: 'string', required: true },
    { name: 'expected', type: 'string' },
    { name: 'text', type: 'string' },
  ],
  [
    launch(),
    input(),
    submit(),
    {
      id: 'set-expected',
      action: 'set-variable',
      name: '设置期望',
      params: { name: 'expected', value: '找到' },
    },
    readSummary('text'),
    {
      id: 'assert-text',
      action: 'assert',
      name: '输出包含期望',
      params: { condition: varCompare('text', 'contains', '${expected}') },
    },
    end,
  ],
  'set-variable + read-text 输出进入变量 + 变量比较。',
);

add(
  14,
  '等待页面稳定',
  keywordVar,
  [
    launch(),
    {
      id: 'wait-stable',
      action: 'wait',
      name: '等待稳定',
      risk: 'normal',
      params: { condition: stable(150) },
    },
    {
      id: 'assert-ready',
      action: 'assert',
      name: '搜索框可用',
      params: { condition: present(T.input) },
    },
    end,
  ],
  '条件等待，不使用固定 sleep。',
);

add(
  15,
  '慢加载结果',
  keywordVar,
  [
    launch(),
    input('${keyword}', stable(120)),
    submit(text(T.summary, '${keyword}')),
    {
      id: 'assert-slow',
      action: 'assert',
      name: '慢结果仍正确',
      params: { condition: text(T.summary, '${keyword}') },
    },
    end,
  ],
  '夹具 slow 变体：1.8s 后才出现结果。',
  { variant: 'slow' },
);

add(
  16,
  '读取输入框当前值',
  [
    { name: 'keyword', type: 'string', required: true },
    { name: 'typed', type: 'string' },
  ],
  [
    launch(),
    input(),
    submit(),
    {
      id: 'read-input',
      action: 'read-text',
      name: '读取输入值',
      risk: 'normal',
      target: T.input,
      params: { output_variable: 'typed', max_chars: 60 },
    },
    {
      id: 'assert-typed',
      action: 'assert',
      name: '输入值一致',
      params: { condition: varCompare('typed', 'equals', '${keyword}') },
    },
    end,
  ],
  'read-text 读取 input value，而不是文本节点。',
);

add(
  17,
  '详情关闭后消失',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    {
      id: 'open-detail',
      action: 'click',
      name: '打开详情',
      risk: 'normal',
      target: T.openFirst,
      postconditions: [present(T.dialog)],
      params: { button: 'left' },
    },
    {
      id: 'close-detail',
      action: 'click',
      name: '关闭详情',
      risk: 'normal',
      target: T.closeDialog,
      postconditions: [absent(T.dialog)],
      params: { button: 'left' },
    },
    {
      id: 'assert-closed',
      action: 'assert',
      name: '弹窗已消失',
      params: { condition: absent(T.dialog) },
    },
    end,
  ],
  'element-absent 作为关闭动作的后置条件。',
);

add(
  18,
  '两次加载更多',
  keywordVar,
  [
    launch(),
    input(),
    submit(),
    {
      id: 'load-1',
      action: 'click',
      name: '加载更多 1',
      risk: 'normal',
      target: T.loadMore,
      postconditions: [text(T.summary, '已加载')],
      params: { button: 'left' },
    },
    {
      id: 'load-2',
      action: 'click',
      name: '加载更多 2',
      risk: 'normal',
      target: T.loadMore,
      postconditions: [text(T.summary, '已加载')],
      params: { button: 'left' },
    },
    {
      id: 'assert-more',
      action: 'assert',
      name: '仍可加载',
      params: { condition: text(T.summary, '已加载') },
    },
    end,
  ],
  '重复懒加载动作。',
);

add(
  19,
  '初始摘要不可见',
  keywordVar,
  [
    launch(),
    {
      id: 'assert-hidden',
      action: 'assert',
      name: '摘要初始隐藏',
      params: { condition: absent(T.summary) },
    },
    end,
  ],
  '负向断言：未搜索时摘要不存在。',
);

add(
  20,
  '有界滚动',
  keywordVar,
  [
    launch(),
    {
      id: 'scroll-page',
      action: 'scroll',
      name: '滚动页面',
      risk: 'normal',
      target: null,
      postconditions: [stable(100)],
      params: {
        direction: 'down',
        amount: 400,
        max_attempts: 3,
        boundary_condition: present(T.footer),
      },
    },
    {
      id: 'assert-footer',
      action: 'assert',
      name: '底部可见',
      params: { condition: present(T.footer) },
    },
    end,
  ],
  'scroll 必须有边界条件和最大次数。',
);

add(
  21,
  '两次搜索并读取断言',
  [
    { name: 'keyword1', type: 'string', required: true },
    { name: 'keyword2', type: 'string', required: true },
  ],
  [
    launch(),
    input('${keyword1}', present(T.summary), 'type-1'),
    submit(present(T.summary), 'submit-1'),
    readSummary('summary1'),
    {
      id: 'assert-1',
      action: 'assert',
      name: '第一次摘要',
      params: { condition: text(T.summary, '${keyword1}') },
    },
    input('${keyword2}', present(T.summary), 'type-2'),
    submit(present(T.summary), 'submit-2'),
    readSummary('summary2'),
    {
      id: 'assert-2',
      action: 'assert',
      name: '第二次摘要',
      params: { condition: text(T.summary, '${keyword2}') },
    },
    end,
  ],
  '两种关键词、两次读取和断言。',
);

const corpus = [];
for (const entry of flows) {
  const result = loadFlow(entry.flow, { forExecution: true });
  if (!result.flow) {
    console.error(
      'INVALID',
      entry.file,
      JSON.stringify(
        result.report.diagnostics.filter((item) => item.severity === 'error'),
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const path = resolve(OUT, `${entry.file}.flow.json`);
  writeFileSync(path, JSON.stringify(result.flow, null, 2));
  corpus.push({
    id: entry.file,
    file: `fixtures/flows/web-golden/${entry.file}.flow.json`,
    variant: entry.meta.variant ?? 'baseline',
    variables: entry.flow.variables.reduce((acc, variable) => {
      if (variable.name === 'keyword') acc[variable.name] = '报告';
      else if (variable.name === 'keyword1') acc[variable.name] = '报告';
      else if (variable.name === 'keyword2') acc[variable.name] = '画像';
      else if (variable.name === 'mode') acc[variable.name] = 'detail';
      else if (variable.required) acc[variable.name] = '报告';
      return acc;
    }, {}),
    name: entry.flow.name,
  });
}
writeFileSync(
  resolve(ROOT, 'tests/replay/web-golden.json'),
  JSON.stringify({ version: '1.0.0', flows: corpus }, null, 2),
);
console.log(`wrote ${flows.length} golden flows`);
