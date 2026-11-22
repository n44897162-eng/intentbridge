/**
 * IntentBridge management UI. Dependency-free DOM views, bundled by the shell.
 * All data flows through the loopback API; the UI never evaluates flow scripts.
 */
import type { Diagnostic, Flow, Permission, Step, Target } from '@intentbridge/action-ir';
import './styles.css';

const PERMISSIONS: Permission[] = [
  'read-ui',
  'read-screen',
  'click',
  'type',
  'select',
  'scroll',
  'launch',
  'navigate',
  'upload',
  'download',
  'clipboard-read',
];

const ACTION_CHOICES = [
  'launch',
  'activate',
  'wait',
  'click',
  'input',
  'select',
  'scroll',
  'read-text',
  'assert',
  'set-variable',
  'branch',
  'compensate',
  'end',
];

interface FlowListEntry {
  id: string;
  name: string;
  platform: string;
  app_scope: string;
  current_revision: number;
  updated_at: string;
  last_status: string | null;
  last_run_at: string | null;
}

interface RunRecord {
  id: string;
  flow_id: string;
  flow_revision: number;
  trigger: string;
  status: string;
  state: string | null;
  started_at: string;
  finished_at: string | null;
  error: { code?: string; message?: string } | null;
  pending: { kind: string; payload: unknown; requested_at: string } | null;
  metrics: { planner_p95_ms?: number; total_elapsed_ms?: number } | null;
  variables: Record<string, unknown> | null;
  action_log: Array<Record<string, unknown>> | null;
  last_seq: number;
}

interface EvidenceRecord {
  id: string;
  step_id: string;
  sha256: string;
  created_at: string;
}

interface RunEventShape {
  seq: number;
  type: string;
  mono_ms: number;
  step_id?: string | null;
  payload: Record<string, unknown>;
}

class ApiError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(message: string, code = 'INTERNAL_ERROR', detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function resolveToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('ib-token', fromUrl);
    url.searchParams.delete('token');
    history.replaceState({}, '', `${url.pathname}${url.hash}`);
    return fromUrl;
  }
  return localStorage.getItem('ib-token') ?? '';
}

class Api {
  private readonly token: string;
  constructor(token: string) {
    this.token = token;
  }
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        'x-ib-token': this.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 300) } };
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        error?.message ?? `HTTP ${response.status}`,
        error?.code ?? 'HTTP_ERROR',
        parsed,
      );
    }
    return parsed as T;
  }
  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

const token = resolveToken();
const api = new Api(token);
const appRoot = document.getElementById('app') as HTMLElement;

let pollTimer: number | undefined;
let renderGeneration = 0;
let notice: { kind: 'ok' | 'error'; text: string; details?: Diagnostic[] } | null = null;
let draft: Flow | null = null;
let draftFlowId: string | null = null;
let selectedStepId: string | null = null;
let activeTab = 'steps';

type Child = Node | string | number | false | null | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'className') {
      element.className = String(value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      (element as unknown as Record<string, unknown>)[key] = value;
    } else {
      element.setAttribute(key, String(value));
    }
  }
  append(element, children);
  return element;
}

function nodes(children: Child[]): Array<Node | string> {
  return children
    .filter(
      (child): child is Node | string =>
        typeof child === 'string' || typeof child === 'number' || child instanceof Node,
    )
    .map((child) => (typeof child === 'number' ? String(child) : child));
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

function clearNotice(): void {
  notice = null;
}

function setNotice(kind: 'ok' | 'error', text: string, details?: Diagnostic[]): void {
  notice = { kind, text, ...(details ? { details } : {}) };
}

function noticeBanner(): HTMLElement | null {
  if (!notice) return null;
  return h(
    'div',
    { className: `notice ${notice.kind}` },
    h('strong', {}, notice.kind === 'ok' ? '完成' : '失败'),
    h('span', {}, notice.text),
    ...(notice.details && notice.details.length > 0
      ? [
          h(
            'ul',
            { className: 'diagnostics' },
            ...notice.details
              .slice(0, 12)
              .map((item) => h('li', {}, `${item.rule} @ ${item.path || '/'}: ${item.message}`)),
          ),
        ]
      : []),
    h(
      'button',
      {
        className: 'link',
        onClick: () => {
          clearNotice();
          void render();
        },
      },
      '关闭',
    ),
  );
}

function nav(path: string): void {
  location.hash = path;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function badge(status: string | null): HTMLElement {
  const map: Record<string, string> = {
    succeeded: 'ok',
    SUCCEEDED: 'ok',
    failed: 'bad',
    FAILED: 'bad',
    cancelled: 'warn',
    CANCELLED: 'warn',
    running: 'run',
    RUNNING: 'run',
    paused: 'warn',
    PAUSED: 'warn',
    outcome_unknown: 'bad',
  };
  return h('span', { className: `badge ${map[status ?? ''] ?? 'muted'}` }, status ?? '未运行');
}

function button(
  label: string,
  onClick: () => void,
  kind: 'primary' | 'ghost' | 'danger' = 'ghost',
): HTMLButtonElement {
  return h('button', { className: `btn ${kind}`, type: 'button', onClick }, label);
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h(
    'section',
    { className: 'panel' },
    h('header', { className: 'panel-head' }, h('h2', {}, title)),
    ...children,
  );
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h(
    'label',
    { className: 'field' },
    h('span', { className: 'field-label' }, label),
    input,
    ...(hint ? [h('span', { className: 'field-hint' }, hint)] : []),
  );
}

function textInput(
  value: string,
  onInput: (value: string) => void,
  placeholder = '',
): HTMLInputElement {
  return h('input', {
    type: 'text',
    value,
    placeholder,
    onInput: (event: Event) => onInput((event.target as HTMLInputElement).value),
  });
}

function textArea(value: string, onInput: (value: string) => void, rows = 8): HTMLTextAreaElement {
  const element = h('textarea', {
    rows: String(rows),
    onInput: (event: Event) => onInput((event.target as HTMLTextAreaElement).value),
  });
  element.value = value;
  return element;
}

function selectBox(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  return h(
    'select',
    { onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
    ...options.map((option) =>
      h('option', { value: option.value, selected: option.value === value }, option.label),
    ),
  );
}

function layout(active: string, ...content: Child[]): HTMLElement {
  const links: Array<[string, string, string]> = [
    ['/flows', '流程', '流程列表'],
    ['/recordings', '录制', '录制会话'],
    ['/runs', '运行', '运行记录'],
    ['/settings', '设置', '设置'],
  ];
  return h(
    'div',
    { className: 'shell' },
    h(
      'aside',
      { className: 'sidebar' },
      h(
        'div',
        { className: 'brand' },
        h('span', { className: 'brand-mark' }, 'IB'),
        h('span', {}, 'IntentBridge'),
      ),
      h(
        'nav',
        {},
        ...links.map(([path, label, title]) =>
          h(
            'a',
            {
              href: `#${path}`,
              className: active === path ? 'active' : '',
              title,
            },
            label,
          ),
        ),
      ),
      h(
        'div',
        { className: 'sidebar-foot' },
        h('span', {}, '本地运行'),
        h('small', {}, 'v0.1 · P0'),
      ),
    ),
    h(
      'main',
      { className: 'main' },
      h(
        'div',
        { className: 'topline' },
        h('span', {}, 'loopback · 无云端'),
        h('span', { className: 'muted' }, '所有数据保存在本机'),
      ),
      noticeBanner(),
      ...content,
    ),
  );
}

function errorView(error: unknown): HTMLElement {
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof ApiError && error.detail
      ? JSON.stringify(error.detail, null, 2).slice(0, 2000)
      : '';
  return layout(
    '',
    h(
      'section',
      { className: 'panel error-panel' },
      h('h2', {}, '加载失败'),
      h('p', {}, message),
      detail ? h('pre', {}, detail) : null,
    ),
  );
}

async function render(): Promise<void> {
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  renderGeneration += 1;
  const generation = renderGeneration;
  const route = parseRoute();
  let view: HTMLElement;
  try {
    if (!token) {
      view = layout(
        '',
        h(
          'section',
          { className: 'panel' },
          h('h2', {}, '需要会话令牌'),
          h('p', {}, '请使用启动日志中带 token 的地址打开控制台。令牌只保存在当前浏览器。'),
        ),
      );
    } else if (route.name === 'flows') view = await flowsView(generation);
    else if (route.name === 'flow') view = await flowView(route.flowId, generation);
    else if (route.name === 'run') view = await runView(route.runId, generation);
    else if (route.name === 'runs') view = await runsView(generation);
    else if (route.name === 'recordings') view = await recordingsView(generation);
    else if (route.name === 'settings') view = await settingsView(generation);
    else view = await flowsView(generation);
  } catch (error) {
    view = errorView(error);
  }
  if (generation !== renderGeneration) return;
  appRoot.replaceChildren(view);
}

function parseRoute():
  | { name: 'flows' }
  | { name: 'flow'; flowId: string }
  | { name: 'run'; runId: string }
  | { name: 'runs' }
  | { name: 'recordings' }
  | { name: 'settings' } {
  const hash = location.hash.replace(/^#/, '') || '/flows';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'flows' && parts[1]) return { name: 'flow', flowId: parts[1] };
  if (parts[0] === 'runs' && parts[1]) return { name: 'run', runId: parts[1] };
  if (parts[0] === 'runs') return { name: 'runs' };
  if (parts[0] === 'recordings') return { name: 'recordings' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'flows' };
}

// ---------------------------------------------------------------- flows list

function importPanel(onImported: () => void): HTMLElement {
  const file = h('input', {
    type: 'file',
    accept: '.json,.ibflow,application/json',
    className: 'file',
  });
  const passphrase = h('input', {
    type: 'password',
    placeholder: '加密包口令（可选）',
    className: 'inline-input',
  });
  file.addEventListener('change', () => {
    void (async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        const raw = JSON.parse(await selected.text()) as Record<string, unknown>;
        const body: Record<string, unknown> = { document: raw };
        if (raw['format'] === 'intentbridge.flow') body['passphrase'] = passphrase.value;
        const result = await api.post<{ flow: Flow }>('/flows/import', body);
        setNotice('ok', `已导入「${result.flow.name}」`);
        onImported();
      } catch (error) {
        setNotice('error', (error as Error).message);
        void render();
      }
    })();
  });
  return h(
    'div',
    { className: 'toolbar' },
    file,
    passphrase,
    h('span', { className: 'muted' }, '选择 JSON 或加密 .ibflow 包'),
  );
}

async function flowsView(generation: number): Promise<HTMLElement> {
  const data = await api.get<{ flows: FlowListEntry[] }>('/flows');
  if (generation !== renderGeneration) return h('div');
  const rows = data.flows.map((flow) =>
    h(
      'tr',
      { className: 'clickable', onClick: () => nav(`/flows/${flow.id}`) },
      h('td', {}, h('strong', {}, flow.name), h('div', { className: 'muted small' }, flow.id)),
      h('td', {}, flow.platform),
      h('td', { className: 'mono small' }, flow.app_scope),
      h('td', {}, `r${flow.current_revision}`),
      h('td', {}, badge(flow.last_status)),
      h('td', { className: 'small' }, formatTime(flow.last_run_at)),
    ),
  );
  return layout(
    '/flows',
    h(
      'div',
      { className: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, '流程'),
        h('p', { className: 'muted' }, '录制、编辑、试运行与审计。'),
      ),
      h(
        'div',
        { className: 'actions' },
        button('录制会话', () => nav('/recordings'), 'primary'),
      ),
    ),
    importPanel(() => void nav('/flows')),
    section(
      '全部流程',
      data.flows.length === 0
        ? h('p', { className: 'muted' }, '还没有流程。导入一个 JSON，或创建录制会话。')
        : h(
            'table',
            { className: 'table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...['名称', '平台', '应用范围', '版本', '最近运行', '时间'].map((label) =>
                  h('th', {}, label),
                ),
              ),
            ),
            h('tbody', {}, ...rows),
          ),
    ),
  );
}

// ---------------------------------------------------------------- flow detail

async function flowView(flowId: string, generation: number): Promise<HTMLElement> {
  const record = await api.get<{
    flow: Flow;
    revision: number;
    hash: string;
    signature_status: string;
  }>(`/flows/${flowId}`);
  if (generation !== renderGeneration) return h('div');
  if (draftFlowId !== flowId) {
    draft = record.flow;
    draftFlowId = flowId;
    selectedStepId = record.flow.steps[0]?.id ?? null;
    activeTab = 'steps';
  } else if (draft && draft.revision !== record.revision) {
    draft = record.flow;
  }
  const current = draft as Flow;
  const tabs: Array<[string, string]> = [
    ['steps', '步骤'],
    ['target', '目标检查器'],
    ['variables', '变量与密钥'],
    ['permissions', '权限'],
    ['json', 'JSON'],
    ['runs', '运行记录'],
  ];

  const save = async (candidate?: Flow): Promise<boolean> => {
    const flowToSave = candidate ?? draft;
    if (!flowToSave) return false;
    try {
      const response = await api.put<{ revision: number; hash: string; warnings: Diagnostic[] }>(
        `/flows/${flowId}`,
        {
          flow: flowToSave,
          created_by: 'shell',
          base_revision: flowToSave.revision,
        },
      );
      // Commit the client-side draft only after the server accepted it.
      draft = flowToSave;
      draft.revision = response.revision;
      draft.updated_at = new Date().toISOString();
      setNotice(
        'ok',
        `已保存为 r${response.revision}${response.warnings?.length ? `（${response.warnings.length} 条警告）` : ''}`,
      );
      await render();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.detail) {
        const detail = error.detail as { detail?: { errors?: Diagnostic[] } };
        setNotice('error', error.message, detail.detail?.errors ?? []);
      } else {
        setNotice('error', (error as Error).message);
      }
      await render();
      return false;
    }
  };

  const download = (filename: string, content: unknown): void => {
    const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = h('a', { href: url, download: filename });
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPlain = (): void => download(`${current.flow_id}.json`, current);
  const exportEncrypted = async (): Promise<void> => {
    const passphrase = window.prompt('设置导出口令（至少 8 位，不会保存）');
    if (!passphrase || passphrase.length < 8) {
      setNotice('error', '口令至少 8 位');
      await render();
      return;
    }
    try {
      const response = await fetch(`/api/flows/${flowId}/export/encrypted`, {
        method: 'POST',
        headers: { 'x-ib-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
      download(`${current.flow_id}.ibflow`, await response.json());
      setNotice('ok', '已导出加密流程包');
      await render();
    } catch (error) {
      setNotice('error', (error as Error).message);
      await render();
    }
  };

  const body = h('div', { className: 'flow-body' });
  const redraw = (): void => {
    body.replaceChildren(
      ...nodes([
        h(
          'div',
          { className: 'tabs' },
          ...tabs.map(([key, label]) =>
            h(
              'button',
              {
                type: 'button',
                className: `tab ${activeTab === key ? 'active' : ''}`,
                onClick: () => {
                  activeTab = key;
                  redraw();
                },
              },
              label,
            ),
          ),
        ),
        ...awaitTab(current, activeTab),
      ]),
    );
  };
  const awaitTab = (flow: Flow, tab: string): Child[] => {
    try {
      switch (tab) {
        case 'target':
          return [targetTab(flow, () => redraw(), save)];
        case 'variables':
          return [variablesTab(flow, () => redraw(), save)];
        case 'permissions':
          return [permissionsTab(flow, save)];
        case 'json':
          return [jsonTab(flow, () => redraw(), save)];
        case 'runs':
          return [runsTab(flow)];
        default:
          return [stepsTab(flow, () => redraw(), save)];
      }
    } catch (error) {
      return [h('div', { className: 'panel error-panel' }, String((error as Error).message))];
    }
  };
  redraw();

  return layout(
    '/flows',
    h(
      'div',
      { className: 'page-head' },
      h(
        'div',
        {},
        h(
          'button',
          { className: 'link', type: 'button', onClick: () => nav('/flows') },
          '← 流程列表',
        ),
        h('h1', {}, current.name),
        h(
          'p',
          { className: 'muted' },
          `${current.platform} · ${current.app_scope.value} · r${current.revision} · ${record.signature_status} · ${record.hash.slice(0, 12)}…`,
        ),
      ),
      h(
        'div',
        { className: 'actions' },
        button('保存', () => void save(), 'primary'),
        button('导出 JSON', exportPlain),
        button('加密导出', () => void exportEncrypted()),
        button('试运行', () => {
          activeTab = 'runs';
          redraw();
        }),
      ),
    ),
    body,
  );
}

function stepsTab(flow: Flow, redraw: () => void, _save: () => Promise<unknown>): HTMLElement {
  if (!selectedStepId || !flow.steps.some((step) => step.id === selectedStepId)) {
    selectedStepId = flow.steps[0]?.id ?? null;
  }
  const step = flow.steps.find((item) => item.id === selectedStepId);
  const list = h(
    'div',
    { className: 'step-list' },
    ...flow.steps.map((item, index) =>
      h(
        'button',
        {
          type: 'button',
          className: `step-row ${item.id === selectedStepId ? 'active' : ''}`,
          onClick: () => {
            selectedStepId = item.id;
            redraw();
          },
        },
        h('span', { className: 'step-index' }, String(index + 1)),
        h('span', { className: 'step-name' }, item.name ?? item.action),
        h('span', { className: 'step-action' }, item.action),
        item.risk && item.risk !== 'normal' ? h('span', { className: 'risk' }, item.risk) : null,
      ),
    ),
    button('＋ 添加步骤', () => {
      const newStep: Step = {
        id: `step-${Date.now().toString(36)}`,
        action: 'end',
        name: '新步骤',
        params: { status: 'success' },
      };
      flow.steps.push(newStep);
      selectedStepId = newStep.id;
      redraw();
    }),
  );
  return h(
    'div',
    { className: 'split' },
    list,
    step
      ? stepEditor(flow, step, redraw)
      : h('div', { className: 'panel muted' }, '选择或添加一个步骤'),
  );
}

function stepEditor(flow: Flow, step: Step, redraw: () => void): HTMLElement {
  const saveStep = async (): Promise<void> => {
    try {
      setNotice('ok', '步骤已修改，点击顶部“保存”写入新版本');
      redraw();
    } catch (error) {
      setNotice('error', (error as Error).message);
      redraw();
    }
  };
  const target = step.target;
  const anchor = target?.anchors;
  const deleteStep = (): void => {
    flow.steps = flow.steps.filter((item) => item.id !== step.id);
    selectedStepId = flow.steps[0]?.id ?? null;
    redraw();
  };
  return h(
    'div',
    { className: 'panel step-editor' },
    h(
      'header',
      { className: 'panel-head' },
      h('h2', {}, `步骤 ${step.id}`),
      button('删除', deleteStep, 'danger'),
    ),
    h(
      'div',
      { className: 'form-grid' },
      field(
        '动作',
        selectBox(
          ACTION_CHOICES.map((value) => ({ value, label: value })),
          step.action,
          (value) => {
            step.action = value as Step['action'];
          },
        ),
      ),
      field(
        '名称',
        textInput(step.name ?? '', (value) => {
          step.name = value;
        }),
      ),
      field(
        '风险',
        selectBox(
          [
            { value: 'normal', label: 'normal' },
            { value: 'sensitive', label: 'sensitive（需批准）' },
            { value: 'irreversible', label: 'irreversible（需批准）' },
          ],
          step.risk ?? 'normal',
          (value) => {
            step.risk = value as Step['risk'];
          },
        ),
      ),
      field(
        '超时 (ms)',
        h('input', {
          type: 'number',
          min: '100',
          max: '120000',
          value: String(step.timeout_ms ?? 30000),
          onInput: (event: Event) => {
            step.timeout_ms = Number((event.target as HTMLInputElement).value);
          },
        }),
      ),
      field(
        '失败处理',
        selectBox(
          [
            { value: 'stop', label: 'stop' },
            { value: 'ask-user', label: 'ask-user' },
            { value: 'goto-step', label: 'goto-step' },
          ],
          typeof step.on_failure === 'string' ? step.on_failure : (step.on_failure?.mode ?? 'stop'),
          (value) => {
            step.on_failure =
              value === 'goto-step'
                ? {
                    mode: 'goto-step',
                    goto_step_id: flow.steps.find((item) => item.id !== step.id)?.id ?? '',
                  }
                : (value as 'stop' | 'ask-user');
          },
        ),
      ),
      field(
        '幂等键',
        textInput(step.retry?.idempotency_key ?? '', (value) => {
          step.retry = { ...(step.retry ?? {}), idempotency_key: value || undefined };
        }),
        '写动作只有声明幂等键才允许自动重试',
      ),
    ),
    section(
      '目标锚点',
      h(
        'div',
        { className: 'form-grid' },
        field(
          'role',
          textInput(anchor?.semantic?.role ?? '', (value) => {
            step.target = ensureTarget(step);
            step.target.anchors.semantic = { ...(step.target.anchors.semantic ?? {}), role: value };
          }),
        ),
        field(
          'accessible name',
          textInput(anchor?.semantic?.name ?? '', (value) => {
            step.target = ensureTarget(step);
            step.target.anchors.semantic = { ...(step.target.anchors.semantic ?? {}), name: value };
          }),
        ),
        field(
          'test id',
          textInput(anchor?.semantic?.test_id ?? '', (value) => {
            step.target = ensureTarget(step);
            step.target.anchors.semantic = {
              ...(step.target.anchors.semantic ?? {}),
              test_id: value,
            };
          }),
        ),
        field(
          'placeholder',
          textInput(anchor?.semantic?.placeholder ?? '', (value) => {
            step.target = ensureTarget(step);
            step.target.anchors.semantic = {
              ...(step.target.anchors.semantic ?? {}),
              placeholder: value,
            };
          }),
        ),
        field(
          '原生标识类型',
          selectBox(
            [
              { value: '', label: '（无）' },
              { value: 'web-test-id', label: 'web-test-id' },
              { value: 'web-dom-id', label: 'web-dom-id' },
              { value: 'uia-automation-id', label: 'uia-automation-id' },
              { value: 'android-resource-id', label: 'android-resource-id' },
              { value: 'android-content-desc', label: 'android-content-desc' },
            ],
            anchor?.native_identity?.kind ?? '',
            (value) => {
              step.target = ensureTarget(step);
              step.target.anchors.native_identity = value
                ? {
                    kind: value as NonNullable<Target['anchors']['native_identity']>['kind'],
                    value: anchor?.native_identity?.value ?? '',
                  }
                : undefined;
            },
          ),
        ),
        field(
          '原生标识值',
          textInput(anchor?.native_identity?.value ?? '', (value) => {
            if (!step.target?.anchors.native_identity) return;
            step.target.anchors.native_identity.value = value;
          }),
        ),
        field(
          '结构路径（逗号分隔）',
          textInput((anchor?.structure?.path ?? []).join(','), (value) => {
            step.target = ensureTarget(step);
            step.target.anchors.structure = {
              ...(step.target.anchors.structure ?? {}),
              path: value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            };
          }),
          '有界路径，禁止无限深绝对路径',
        ),
        field(
          '视觉 dHash',
          textInput(anchor?.visual?.dhash ?? '', (value) => {
            step.target = ensureTarget(step);
            step.target.anchors.visual = { ...(step.target.anchors.visual ?? {}), dhash: value };
          }),
          '视觉仅作为辅助证据',
        ),
      ),
    ),
    section(
      '参数（JSON）',
      textArea(
        JSON.stringify(step.params ?? {}, null, 2),
        (value) => {
          try {
            step.params = JSON.parse(value) as Step['params'];
            setNotice('ok', '参数 JSON 已更新（保存步骤后生效）');
          } catch (error) {
            setNotice('error', `参数 JSON 无效：${(error as Error).message}`);
          }
        },
        6,
      ),
    ),
    section(
      '前置 / 后置条件（JSON 数组）',
      h('div', { className: 'mono small muted' }, '前置条件'),
      textArea(
        JSON.stringify(step.preconditions ?? [], null, 2),
        (value) => {
          try {
            step.preconditions = JSON.parse(value) as Step['preconditions'];
          } catch (error) {
            setNotice('error', `前置条件 JSON 无效：${(error as Error).message}`);
          }
        },
        5,
      ),
      h('div', { className: 'mono small muted' }, '后置条件（写动作必需）'),
      textArea(
        JSON.stringify(step.postconditions ?? [], null, 2),
        (value) => {
          try {
            step.postconditions = JSON.parse(value) as Step['postconditions'];
          } catch (error) {
            setNotice('error', `后置条件 JSON 无效：${(error as Error).message}`);
          }
        },
        5,
      ),
    ),
    h(
      'div',
      { className: 'actions' },
      button('应用步骤修改', () => void saveStep(), 'primary'),
    ),
  );
}

function ensureTarget(step: Step): Target {
  if (!step.target) step.target = { anchors: {} };
  return step.target;
}

function targetTab(flow: Flow, redraw: () => void, _save: () => Promise<unknown>): HTMLElement {
  const step =
    flow.steps.find((item) => item.id === selectedStepId && item.target) ??
    flow.steps.find((item) => item.target);
  const container = h('div', { className: 'panel' });
  if (!step) {
    container.append(h('p', { className: 'muted' }, '选择步骤后查看锚点。'));
    return container;
  }
  const renderRanking = async (): Promise<void> => {
    try {
      const runs = await api.get<{ runs: RunRecord[] }>(`/flows/${flow.flow_id}/runs`);
      const latest = runs.runs[0];
      if (!latest) {
        container.replaceChildren(
          h('p', { className: 'muted' }, '尚无运行记录。执行一次试运行后可查看候选评分。'),
        );
        return;
      }
      const detail = await api.get<{ events: RunEventShape[] }>(`/runs/${latest.id}`);
      const ranking = [...detail.events]
        .reverse()
        .find((event) => event.type === 'CandidatesRanked' && event.step_id === step.id);
      const candidates =
        (ranking?.payload['candidates'] as Array<{
          candidate_id: string;
          total: number;
          eligible: boolean;
          auto_eligible: boolean;
          reasons: string[];
          evidence: Record<string, number>;
        }>) ?? [];
      container.replaceChildren(
        ...nodes([
          h('h3', {}, `步骤 ${step.id} 的锚点`),
          h('pre', { className: 'pre' }, JSON.stringify(step.target ?? null, null, 2)),
          h('h3', {}, '最近一次候选评分'),
          latest
            ? h(
                'p',
                { className: 'muted small' },
                `运行 ${latest.id} · ${formatTime(latest.started_at)}`,
              )
            : null,
          candidates.length === 0
            ? h('p', { className: 'muted' }, '该步骤在最近运行中没有候选（可能未解析或未到达）。')
            : h(
                'table',
                { className: 'table' },
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    ...['候选', '总分', '语义', '结构', '原生', '视觉', '可用', '自动', '理由'].map(
                      (label) => h('th', {}, label),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  ...candidates.map((candidate) =>
                    h(
                      'tr',
                      {},
                      h('td', { className: 'mono small' }, candidate.candidate_id),
                      h('td', {}, candidate.total.toFixed(2)),
                      h('td', {}, candidate.evidence.semantic?.toFixed(2) ?? '0'),
                      h('td', {}, candidate.evidence.structure?.toFixed(2) ?? '0'),
                      h('td', {}, candidate.evidence.native?.toFixed(2) ?? '0'),
                      h('td', {}, candidate.evidence.visual?.toFixed(2) ?? '0'),
                      h('td', {}, candidate.eligible ? '是' : '否'),
                      h('td', {}, candidate.auto_eligible ? '是' : '否'),
                      h('td', { className: 'small' }, candidate.reasons.join(' · ')),
                    ),
                  ),
                ),
              ),
          button('刷新', () => void renderRanking()),
        ]),
      );
    } catch (error) {
      container.replaceChildren(h('p', { className: 'error' }, String((error as Error).message)));
    }
  };
  void renderRanking();
  void redraw;
  return container;
}

function variablesTab(flow: Flow, redraw: () => void, _save: () => Promise<unknown>): HTMLElement {
  const variables = flow.variables;
  const table = h(
    'table',
    { className: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['名称', '类型', '必填', '敏感', '默认值', '操作'].map((label) => h('th', {}, label)),
      ),
    ),
    h(
      'tbody',
      {},
      ...variables.map((variable, index) =>
        h(
          'tr',
          {},
          h(
            'td',
            {},
            textInput(variable.name, (value) => {
              variable.name = value;
            }),
          ),
          h(
            'td',
            {},
            selectBox(
              [
                { value: 'string', label: 'string' },
                { value: 'number', label: 'number' },
                { value: 'boolean', label: 'boolean' },
                { value: 'date', label: 'date' },
              ],
              variable.type,
              (value) => {
                variable.type = value as typeof variable.type;
              },
            ),
          ),
          h(
            'td',
            {},
            h('input', {
              type: 'checkbox',
              checked: variable.required === true,
              onChange: (event: Event) => {
                variable.required = (event.target as HTMLInputElement).checked;
              },
            }),
          ),
          h(
            'td',
            {},
            h('input', {
              type: 'checkbox',
              checked: variable.sensitive === true,
              onChange: (event: Event) => {
                variable.sensitive = (event.target as HTMLInputElement).checked;
              },
            }),
          ),
          h(
            'td',
            {},
            textInput(variable.default === undefined ? '' : String(variable.default), (value) => {
              variable.default = value === '' ? undefined : value;
            }),
          ),
          h(
            'td',
            {},
            button(
              '删除',
              () => {
                flow.variables.splice(index, 1);
                redraw();
              },
              'danger',
            ),
          ),
        ),
      ),
    ),
  );
  const secrets = h('div', { className: 'panel' });
  const loadSecrets = async (): Promise<void> => {
    const data = await api.get<{ aliases: Array<{ alias: string; created_at: string }> }>(
      '/secrets',
    );
    const aliasInput = h('input', {
      type: 'text',
      placeholder: '例如 bank-pin',
      className: 'inline-input',
    });
    const valueInput = h('input', {
      type: 'password',
      placeholder: '密钥值（仅本地加密保存）',
      className: 'inline-input',
    });
    secrets.replaceChildren(
      h('h3', {}, '密钥（只显示别名）'),
      data.aliases.length === 0
        ? h('p', { className: 'muted' }, '没有密钥。流程中的 input 值可使用 secret://别名。')
        : h(
            'table',
            { className: 'table' },
            h(
              'thead',
              {},
              h('tr', {}, h('th', {}, '别名'), h('th', {}, '创建时间'), h('th', {}, '操作')),
            ),
            h(
              'tbody',
              {},
              ...data.aliases.map((item) =>
                h(
                  'tr',
                  {},
                  h('td', { className: 'mono' }, item.alias),
                  h('td', {}, formatTime(item.created_at)),
                  h(
                    'td',
                    {},
                    button(
                      '删除',
                      async () => {
                        await api.del(`/secrets/${item.alias}`);
                        await loadSecrets();
                      },
                      'danger',
                    ),
                  ),
                ),
              ),
            ),
          ),
      h(
        'div',
        { className: 'toolbar' },
        aliasInput,
        valueInput,
        button(
          '添加密钥',
          async () => {
            try {
              await api.put(`/secrets/${encodeURIComponent(aliasInput.value.trim())}`, {
                value: valueInput.value,
              });
              setNotice('ok', '密钥已加密保存');
              await loadSecrets();
              await render();
            } catch (error) {
              setNotice('error', (error as Error).message);
              await render();
            }
          },
          'primary',
        ),
      ),
      h(
        'p',
        { className: 'muted small' },
        '密钥不会出现在流程 JSON、日志或界面中；导出流程仅包含别名。',
      ),
    );
  };
  void loadSecrets();
  return h(
    'div',
    {},
    section(
      '变量',
      table,
      h(
        'div',
        { className: 'actions' },
        button('添加变量', () => {
          flow.variables.push({
            name: `variable${flow.variables.length + 1}`,
            type: 'string',
            required: false,
            sensitive: false,
          });
          redraw();
        }),
      ),
    ),
    secrets,
  );
}

function permissionsTab(flow: Flow, save: () => Promise<unknown>): HTMLElement {
  const scope = flow.app_scope;
  return section(
    '权限与应用范围',
    h('p', { className: 'muted' }, '权限按“流程 × 应用域 × 能力”声明；运行时越界会暂停。'),
    h(
      'div',
      { className: 'checks' },
      ...PERMISSIONS.map((permission) =>
        h(
          'label',
          { className: 'check' },
          h('input', {
            type: 'checkbox',
            checked: flow.permissions.includes(permission),
            onChange: (event: Event) => {
              const checked = (event.target as HTMLInputElement).checked;
              if (checked && !flow.permissions.includes(permission))
                flow.permissions.push(permission);
              if (!checked)
                flow.permissions = flow.permissions.filter((item) => item !== permission);
            },
          }),
          h('span', {}, permission),
        ),
      ),
    ),
    h(
      'div',
      { className: 'form-grid' },
      field(
        '平台',
        textInput(flow.platform, () => {}),
      ),
      field(
        '应用范围类型',
        textInput(scope.kind, () => {}),
      ),
      field(
        '应用范围值',
        textInput(scope.value, (value) => {
          scope.value = value;
        }),
      ),
      field(
        '窗口标题 / 进程',
        textInput(scope.window_title ?? scope.process_name ?? '', (value) => {
          if (flow.platform === 'windows') scope.process_name = value;
          else scope.window_title = value;
        }),
      ),
    ),
    h(
      'div',
      { className: 'actions' },
      button('保存权限', () => void save(), 'primary'),
    ),
  );
}

function jsonTab(
  flow: Flow,
  redraw: () => void,
  save: (candidate?: Flow) => Promise<boolean>,
): HTMLElement {
  const area = textArea(JSON.stringify(flow, null, 2), () => {}, 24);
  return section(
    '专家 JSON 视图',
    h(
      'p',
      { className: 'muted' },
      '导入时会运行 schema 校验与逐版本迁移；保存后产生不可变 revision。',
    ),
    area,
    h(
      'div',
      { className: 'actions' },
      button(
        '应用 JSON',
        async () => {
          try {
            const parsed = JSON.parse(area.value) as Flow;
            draft = parsed;
            await save();
          } catch (error) {
            setNotice('error', `JSON 无效：${(error as Error).message}`);
            await render();
          }
        },
        'primary',
      ),
      button('重新载入', redraw),
    ),
  );
}

function runsTab(flow: Flow): HTMLElement {
  const container = h('div', { className: 'panel' });
  let autoApprove = false;
  let pickFirst = false;
  let singleStep = false;
  let startStep = flow.steps[0]?.id ?? '';
  const variableInputs = new Map<string, HTMLInputElement>();
  const startPanel = section(
    '试运行',
    h(
      'div',
      { className: 'form-grid' },
      ...flow.variables.map((variable) => {
        const input = h('input', {
          type: variable.sensitive ? 'password' : 'text',
          placeholder: variable.sensitive
            ? '运行时从密钥/输入读取，不保存'
            : variable.default === undefined
              ? ''
              : String(variable.default),
        });
        variableInputs.set(variable.name, input);
        return field(
          `${variable.name}（${variable.type}${variable.required ? '，必填' : ''}）`,
          input,
        );
      }),
      field(
        '从步骤开始',
        selectBox(
          flow.steps.map((step) => ({
            value: step.id,
            label: `${step.name ?? step.action} (${step.id})`,
          })),
          startStep,
          (value) => {
            startStep = value;
          },
        ),
      ),
    ),
    h(
      'div',
      { className: 'checks' },
      h(
        'label',
        { className: 'check' },
        h('input', {
          type: 'checkbox',
          onChange: (event: Event) => {
            autoApprove = (event.target as HTMLInputElement).checked;
          },
        }),
        h('span', {}, '自动批准 sensitive 步骤'),
      ),
      h(
        'label',
        { className: 'check' },
        h('input', {
          type: 'checkbox',
          onChange: (event: Event) => {
            pickFirst = (event.target as HTMLInputElement).checked;
          },
        }),
        h('span', {}, '歧义时选第一个候选（仅测试）'),
      ),
      h(
        'label',
        { className: 'check' },
        h('input', {
          type: 'checkbox',
          onChange: (event: Event) => {
            singleStep = (event.target as HTMLInputElement).checked;
          },
        }),
        h('span', {}, '单步运行'),
      ),
    ),
    h(
      'div',
      { className: 'actions' },
      button(
        '开始运行',
        async () => {
          try {
            const variables: Record<string, unknown> = {};
            for (const [name, input] of variableInputs) {
              if (input.value !== '') variables[name] = input.value;
            }
            const response = await api.post<{ run_id: string }>(`/flows/${flow.flow_id}/runs`, {
              variables,
              auto_approve: autoApprove,
              pick: pickFirst ? 'first' : 'none',
              start_step_id: startStep || undefined,
              single_step: singleStep,
              trigger: 'trial',
            });
            setNotice('ok', `运行已开始 ${response.run_id}`);
            nav(`/runs/${response.run_id}`);
          } catch (error) {
            setNotice('error', (error as Error).message);
            await render();
          }
        },
        'primary',
      ),
    ),
  );
  const list = h('div', {});
  const load = async (): Promise<void> => {
    try {
      const data = await api.get<{ runs: RunRecord[] }>(`/flows/${flow.flow_id}/runs`);
      list.replaceChildren(
        data.runs.length === 0
          ? h('p', { className: 'muted' }, '尚无运行记录。')
          : h(
              'table',
              { className: 'table' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  ...['运行', '状态', '开始', '耗时', '操作'].map((label) => h('th', {}, label)),
                ),
              ),
              h(
                'tbody',
                {},
                ...data.runs.map((run) =>
                  h(
                    'tr',
                    {},
                    h('td', { className: 'mono small' }, run.id),
                    h('td', {}, badge(run.status)),
                    h('td', {}, formatTime(run.started_at)),
                    h(
                      'td',
                      {},
                      run.metrics?.total_elapsed_ms
                        ? `${Math.round(run.metrics.total_elapsed_ms)} ms`
                        : '—',
                    ),
                    h(
                      'td',
                      {},
                      button('查看', () => nav(`/runs/${run.id}`)),
                    ),
                  ),
                ),
              ),
            ),
      );
    } catch (error) {
      list.replaceChildren(h('p', { className: 'error' }, String((error as Error).message)));
    }
  };
  void load();
  container.append(startPanel, section('历史运行', list));
  return container;
}

// ------------------------------------------------------------------ run view

async function runView(runId: string, generation: number): Promise<HTMLElement> {
  const detail = await api.get<{
    run: RunRecord;
    events: RunEventShape[];
    evidence: EvidenceRecord[];
    active: boolean;
  }>(`/runs/${runId}`);
  if (generation !== renderGeneration) return h('div');
  const run = detail.run;
  const active = detail.active || run.status === 'running' || run.status === 'paused';

  const decision = run.pending ? decisionPanel(run) : null;
  const timeline = detail.events.map((event) =>
    h(
      'details',
      {
        className: `timeline-row ${event.type === 'StepFailed' || event.type === 'RunPaused' ? 'bad' : ''}`,
      },
      h(
        'summary',
        {},
        h('span', { className: 'seq mono' }, `#${event.seq}`),
        h('span', { className: 'event-type' }, event.type),
        event.step_id ? h('span', { className: 'mono small muted' }, event.step_id) : null,
        h('span', { className: 'mono small muted' }, `${Math.round(event.mono_ms)} ms`),
      ),
      h('pre', { className: 'pre small' }, JSON.stringify(event.payload, null, 2)),
    ),
  );
  const evidence =
    detail.evidence.length > 0
      ? h(
          'div',
          { className: 'evidence-grid' },
          ...detail.evidence.map((item) =>
            h(
              'figure',
              {},
              h('img', {
                src: `/api/evidence/${item.id}?token=${encodeURIComponent(token)}`,
                alt: `证据 ${item.step_id}`,
                loading: 'lazy',
              }),
              h(
                'figcaption',
                {},
                `${item.step_id} · ${formatTime(item.created_at)} · ${item.sha256.slice(0, 12)}…`,
              ),
            ),
          ),
        )
      : h(
          'p',
          { className: 'muted' },
          '本次运行没有保存证据（成功且未要求保留，或裁剪区域不可用）。',
        );

  if (active && generation === renderGeneration) {
    pollTimer = window.setTimeout(() => void render(), 900);
  }

  return layout(
    '/runs',
    h(
      'div',
      { className: 'page-head' },
      h(
        'div',
        {},
        h(
          'button',
          { className: 'link', type: 'button', onClick: () => nav('/runs') },
          '← 运行记录',
        ),
        h('h1', {}, `运行 ${run.id}`),
        h(
          'p',
          { className: 'muted' },
          `${run.flow_id} · r${run.flow_revision} · ${run.trigger} · ${formatTime(run.started_at)}`,
        ),
      ),
      h(
        'div',
        { className: 'actions' },
        badge(run.status),
        button('导出诊断包', () =>
          window.open(
            `/api/runs/${run.id}/diagnostics?token=${encodeURIComponent(token)}`,
            '_blank',
          ),
        ),
        active
          ? button(
              '取消运行',
              async () => {
                await api.post(`/runs/${run.id}/cancel`, {});
                await render();
              },
              'danger',
            )
          : null,
      ),
    ),
    run.error
      ? h(
          'div',
          { className: 'panel error-panel' },
          h('h3', {}, `${run.error.code ?? 'ERROR'}`),
          h('p', {}, run.error.message ?? ''),
        )
      : null,
    decision,
    h(
      'div',
      { className: 'metrics' },
      h(
        'div',
        {},
        h('span', { className: 'muted' }, '状态'),
        h('strong', {}, run.state ?? run.status),
      ),
      h(
        'div',
        {},
        h('span', { className: 'muted' }, '规划 P95'),
        h('strong', {}, `${run.metrics?.planner_p95_ms?.toFixed(2) ?? '—'} ms`),
      ),
      h(
        'div',
        {},
        h('span', { className: 'muted' }, '总耗时'),
        h(
          'strong',
          {},
          run.metrics?.total_elapsed_ms ? `${Math.round(run.metrics.total_elapsed_ms)} ms` : '—',
        ),
      ),
      h(
        'div',
        {},
        h('span', { className: 'muted' }, '事件数'),
        h('strong', {}, String(detail.events.length)),
      ),
    ),
    section('时间轴', h('div', { className: 'timeline' }, ...timeline)),
    section('证据', evidence),
  );
}

function decisionPanel(run: RunRecord): HTMLElement {
  const pending = run.pending;
  if (!pending) return h('div');
  const act = async (value: unknown): Promise<void> => {
    try {
      await api.post(`/runs/${run.id}/decision`, { kind: pending.kind, value });
      setNotice('ok', '已提交决定');
      await render();
    } catch (error) {
      setNotice('error', (error as Error).message);
      await render();
    }
  };
  const payload = pending.payload as Record<string, unknown>;
  if (pending.kind === 'approval') {
    const summary = payload as {
      action?: string;
      risk?: string;
      target_label?: string;
      params_preview?: unknown;
      reasons?: string[];
    };
    return section(
      '等待人工批准',
      h(
        'p',
        {},
        `动作 ${summary.action ?? ''}（${summary.risk ?? ''}）目标：${summary.target_label ?? '未知'}`,
      ),
      h('pre', { className: 'pre small' }, JSON.stringify(summary.params_preview ?? {}, null, 2)),
      h('p', { className: 'muted small' }, (summary.reasons ?? []).join(' · ')),
      h(
        'div',
        { className: 'actions' },
        button('批准', () => void act(true), 'primary'),
        button('拒绝', () => void act(false), 'danger'),
      ),
    );
  }
  if (pending.kind === 'disambiguation') {
    const reason = String(payload['reason'] ?? '');
    const candidates =
      (payload['candidates'] as Array<{
        candidate: {
          candidate_id: string;
          semantic?: { name?: string; role?: string; test_id?: string };
          structure?: { path?: string[] };
        };
        total: number;
        reasons: string[];
      }>) ?? [];
    return section(
      '需要确认目标',
      h('p', {}, `原因：${reason}。引擎不会在不确定时执行。`),
      h(
        'div',
        { className: 'candidates' },
        ...candidates.map((item) =>
          h(
            'button',
            {
              type: 'button',
              className: 'candidate',
              onClick: () => void act(item.candidate.candidate_id),
            },
            h('strong', {}, item.candidate.semantic?.name ?? item.candidate.candidate_id),
            h(
              'span',
              { className: 'muted small' },
              `${item.candidate.semantic?.role ?? ''} · ${item.candidate.semantic?.test_id ?? ''} · score ${item.total.toFixed(2)}`,
            ),
            h(
              'span',
              { className: 'mono small muted' },
              (item.candidate.structure?.path ?? []).join(' > '),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'actions' },
        button(
          '取消运行',
          async () => {
            await api.post(`/runs/${run.id}/cancel`, {});
            await render();
          },
          'danger',
        ),
      ),
    );
  }
  if (pending.kind === 'outcome') {
    const error = payload as { code?: string; message?: string };
    return section(
      '外部副作用未知',
      h('p', {}, `${error.code ?? ''}：${error.message ?? ''}`),
      h('p', { className: 'muted' }, '引擎无法判断上一次写操作是否生效。盲目重试可能重复副作用。'),
      h(
        'div',
        { className: 'actions' },
        button('确认已成功', () => void act('succeeded'), 'primary'),
        button('确认未成功', () => void act('failed')),
        button('重试（人工授权）', () => void act('retry'), 'danger'),
      ),
    );
  }
  const options = (payload['options'] as string[]) ?? [];
  return section(
    '运行已暂停',
    h('p', {}, `原因：${String(payload['reason'] ?? pending.kind)}`),
    h(
      'div',
      { className: 'actions' },
      ...options.map((option) =>
        button(
          optionLabel(option),
          () => void act(option),
          option === 'stop' ? 'danger' : 'primary',
        ),
      ),
    ),
  );
}

function optionLabel(option: string): string {
  const labels: Record<string, string> = {
    resume: '继续',
    stop: '停止',
    retry: '重试该步',
    skip: '跳过该步',
    compensate: '执行补偿',
  };
  return labels[option] ?? option;
}

// --------------------------------------------------------------- runs list

async function runsView(generation: number): Promise<HTMLElement> {
  const data = await api.get<{ runs: RunRecord[] }>('/runs');
  if (generation !== renderGeneration) return h('div');
  return layout(
    '/runs',
    h(
      'div',
      { className: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, '运行记录'),
        h('p', { className: 'muted' }, '每次运行的状态、事件与证据。'),
      ),
    ),
    section(
      '最近运行',
      data.runs.length === 0
        ? h('p', { className: 'muted' }, '还没有运行。打开一个流程并试运行。')
        : h(
            'table',
            { className: 'table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...['运行', '流程', '触发', '状态', '开始', '操作'].map((label) =>
                  h('th', {}, label),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              ...data.runs.map((run) =>
                h(
                  'tr',
                  {},
                  h('td', { className: 'mono small' }, run.id),
                  h('td', { className: 'mono small' }, run.flow_id),
                  h('td', {}, run.trigger),
                  h('td', {}, badge(run.status)),
                  h('td', {}, formatTime(run.started_at)),
                  h(
                    'td',
                    {},
                    button('查看', () => nav(`/runs/${run.id}`)),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

// ------------------------------------------------------------ recordings

async function recordingsView(generation: number): Promise<HTMLElement> {
  const data = await api.get<{
    recordings: Array<{
      id: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      flow_id: string | null;
      warnings: string[];
      events: unknown[];
    }>;
  }>('/recordings');
  if (generation !== renderGeneration) return h('div');
  return layout(
    '/recordings',
    h(
      'div',
      { className: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, '录制会话'),
        h(
          'p',
          { className: 'muted' },
          '浏览器扩展或 `ib-web record` 将事件推送到这里；完成后生成可校验的流程草稿。',
        ),
      ),
      h(
        'div',
        { className: 'actions' },
        button(
          '新建会话',
          async () => {
            const created = await api.post<{ id: string }>('/recordings', {});
            setNotice('ok', `录制会话 ${created.id} 已创建，等待扩展发送事件`);
            await render();
          },
          'primary',
        ),
      ),
    ),
    section(
      '会话',
      data.recordings.length === 0
        ? h('p', { className: 'muted' }, '暂无录制会话。')
        : h(
            'table',
            { className: 'table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...['会话', '状态', '事件数', '开始', '流程', '操作'].map((label) =>
                  h('th', {}, label),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              ...data.recordings.map((recording) =>
                h(
                  'tr',
                  {},
                  h('td', { className: 'mono small' }, recording.id),
                  h('td', {}, badge(recording.status)),
                  h('td', {}, String(recording.events.length)),
                  h('td', {}, formatTime(recording.started_at)),
                  h('td', { className: 'mono small' }, recording.flow_id ?? '—'),
                  h(
                    'td',
                    {},
                    recording.status === 'recording'
                      ? button(
                          '完成并生成流程',
                          async () => {
                            const name =
                              window.prompt('流程名称', '录制的 Web 流程') ?? '录制的 Web 流程';
                            try {
                              const result = await api.post<{ flow: Flow; warnings: string[] }>(
                                `/recordings/${recording.id}/finish`,
                                { name },
                              );
                              setNotice(
                                'ok',
                                `已生成流程「${result.flow.name}」${result.warnings.length ? `（${result.warnings.length} 条提示）` : ''}`,
                              );
                              nav(`/flows/${result.flow.flow_id}`);
                            } catch (error) {
                              setNotice('error', (error as Error).message);
                              await render();
                            }
                          },
                          'primary',
                        )
                      : button(
                          '打开流程',
                          () => recording.flow_id && nav(`/flows/${recording.flow_id}`),
                        ),
                  ),
                ),
              ),
            ),
          ),
      h(
        'p',
        { className: 'muted small' },
        '提示：密码字段不会录制；录制只保存目标锚点和可观察的后置条件。',
      ),
    ),
  );
}

// --------------------------------------------------------------- settings

async function settingsView(generation: number): Promise<HTMLElement> {
  const [settingsData, stats] = await Promise.all([
    api.get<{
      settings: Record<string, unknown>;
      defaults: Record<string, unknown>;
      data_dir: string;
    }>('/settings'),
    api.get<Record<string, unknown>>('/stats'),
  ]);
  if (generation !== renderGeneration) return h('div');
  const form = h('div', { className: 'form-grid' });
  const inputs = new Map<string, HTMLInputElement>();
  const add = (key: string, label: string, value: string, type = 'text'): void => {
    const input = h('input', { type, value });
    inputs.set(key, input);
    form.append(field(label, input));
  };
  add(
    'evidence_retention_days',
    '证据保留天数',
    String(settingsData.settings['evidence_retention_days'] ?? 7),
    'number',
  );
  add(
    'storage_limit_mb',
    '证据存储上限 (MB)',
    String(settingsData.settings['storage_limit_mb'] ?? 512),
    'number',
  );
  add('log_level', '日志级别', String(settingsData.settings['log_level'] ?? 'info'));
  const headless = h('input', {
    type: 'checkbox',
    checked: Boolean(settingsData.settings['headless']),
  });
  const modelAdapter = h('input', { type: 'checkbox', checked: false, disabled: true });
  return layout(
    '/settings',
    h(
      'div',
      { className: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, '设置'),
        h('p', { className: 'muted' }, '全部本地生效；模型适配器不在 v1 范围。'),
      ),
    ),
    section(
      '运行与证据',
      form,
      h(
        'div',
        { className: 'checks' },
        h(
          'label',
          { className: 'check' },
          headless,
          h('span', {}, '无头浏览器（关闭后试运行会弹出窗口）'),
        ),
        h('label', { className: 'check' }, modelAdapter, h('span', {}, '模型适配器（v1 禁用）')),
      ),
      h(
        'div',
        { className: 'actions' },
        button(
          '保存设置',
          async () => {
            try {
              await api.put('/settings', {
                evidence_retention_days: Number(inputs.get('evidence_retention_days')?.value ?? 7),
                storage_limit_mb: Number(inputs.get('storage_limit_mb')?.value ?? 512),
                log_level: inputs.get('log_level')?.value ?? 'info',
                headless: headless.checked,
              });
              setNotice('ok', '设置已保存');
              await render();
            } catch (error) {
              setNotice('error', (error as Error).message);
              await render();
            }
          },
          'primary',
        ),
      ),
    ),
    section(
      '本地数据',
      h(
        'pre',
        { className: 'pre small' },
        JSON.stringify({ ...stats, data_dir: settingsData.data_dir }, null, 2),
      ),
      h(
        'div',
        { className: 'actions' },
        button('清理过期证据', async () => {
          await api.post('/maintenance/cleanup', {});
          setNotice('ok', '已清理');
          await render();
        }),
        button('备份数据库', async () => {
          const result = await api.post<{ path: string }>('/maintenance/backup', {});
          setNotice('ok', `备份已写入 ${result.path}`);
          await render();
        }),
        button('下载总诊断包', () =>
          window.open(`/api/diagnostics?token=${encodeURIComponent(token)}`, '_blank'),
        ),
      ),
    ),
  );
}

window.addEventListener('hashchange', () => {
  clearNotice();
  void render();
});

void render();
