/** Extension popup: record, review, run and answer pauses. */
import type { Flow } from '@intentbridge/action-ir';

interface StoredFlow {
  flow: Flow;
  updated_at: string;
}

interface RuntimeState {
  status: string;
  flow_id?: string;
  run_id?: string;
  state?: string;
  error?: { code?: string; message?: string } | null;
  pending?: { kind: string; payload: unknown } | null;
  events?: number;
  summary?: { status: string; state: string };
}

const root = document.getElementById('root') as HTMLElement;
const statusEl = document.createElement('div');
const pendingEl = document.createElement('div');
const flowsEl = document.createElement('div');
let activeTabId: number | null = null;
let activeTabUrl = '';
let expandedFlow: string | null = null;
const variableValues = new Map<string, string>();
let runtime: RuntimeState = { status: 'idle' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | null | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'className') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value' || key === 'checked' || key === 'disabled')
      (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === false) continue;
    node.append(child);
  }
  return node;
}

function send<T = unknown>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function statusBadge(text: string): HTMLElement {
  return el('span', { className: `badge ${text}` }, text);
}

async function refreshStatus(): Promise<void> {
  const response = await send<{ ok: boolean; runtime: RuntimeState }>({ type: 'ib:get-runtime' });
  if (response?.ok) runtime = response.runtime;
  statusEl.replaceChildren(
    el('div', { className: 'row' }, el('strong', {}, '状态'), statusBadge(runtime.status)),
    runtime.state
      ? el('div', { className: 'muted small' }, `引擎状态：${runtime.state}`)
      : el('span'),
    runtime.error
      ? el(
          'div',
          { className: 'error small' },
          `${runtime.error.code ?? ''} ${runtime.error.message ?? ''}`,
        )
      : el('span'),
    runtime.events !== undefined
      ? el('div', { className: 'muted small' }, `事件：${runtime.events}`)
      : el('span'),
  );
  renderPending();
}

function renderPending(): void {
  const pending = runtime.pending;
  if (!pending) {
    pendingEl.replaceChildren();
    return;
  }
  const payload = pending.payload as Record<string, unknown>;
  const decide = async (value: unknown): Promise<void> => {
    await send({ type: 'ib:decision', kind: pending.kind, value });
    await refreshStatus();
  };
  if (pending.kind === 'approval') {
    pendingEl.replaceChildren(
      el(
        'div',
        { className: 'card warning' },
        el('strong', {}, '需要批准'),
        el(
          'p',
          { className: 'small' },
          `动作 ${String(payload['action'] ?? '')}（${String(payload['risk'] ?? '')}）`,
        ),
        el(
          'div',
          { className: 'row' },
          el('button', { onClick: () => void decide(true) }, '批准'),
          el('button', { className: 'danger', onClick: () => void decide(false) }, '拒绝'),
        ),
      ),
    );
    return;
  }
  if (pending.kind === 'disambiguation') {
    const candidates =
      (payload['candidates'] as Array<{
        candidate: {
          candidate_id: string;
          semantic?: { name?: string; role?: string; test_id?: string };
        };
        total: number;
      }>) ?? [];
    pendingEl.replaceChildren(
      el(
        'div',
        { className: 'card warning' },
        el('strong', {}, '需要确认目标'),
        ...candidates.map((item) =>
          el(
            'button',
            { className: 'candidate', onClick: () => void decide(item.candidate.candidate_id) },
            el('strong', {}, item.candidate.semantic?.name ?? item.candidate.candidate_id),
            el(
              'span',
              { className: 'muted small' },
              `${item.candidate.semantic?.role ?? ''} · ${item.candidate.semantic?.test_id ?? ''} · ${item.total.toFixed(2)}`,
            ),
          ),
        ),
      ),
    );
    return;
  }
  if (pending.kind === 'outcome') {
    pendingEl.replaceChildren(
      el(
        'div',
        { className: 'card warning' },
        el('strong', {}, '副作用未知'),
        el('p', { className: 'small' }, String((payload as { message?: string }).message ?? '')),
        el(
          'div',
          { className: 'row' },
          el('button', { onClick: () => void decide('succeeded') }, '已成功'),
          el('button', { onClick: () => void decide('failed') }, '未成功'),
          el('button', { className: 'danger', onClick: () => void decide('retry') }, '重试'),
        ),
      ),
    );
    return;
  }
  const options = (payload['options'] as string[]) ?? [];
  pendingEl.replaceChildren(
    el(
      'div',
      { className: 'card warning' },
      el('strong', {}, '运行已暂停'),
      el('p', { className: 'small' }, String(payload['reason'] ?? pending.kind)),
      el(
        'div',
        { className: 'row' },
        ...options.map((option) => el('button', { onClick: () => void decide(option) }, option)),
      ),
    ),
  );
}

async function grantCurrentSite(): Promise<void> {
  if (!activeTabUrl) return;
  const origin = new URL(activeTabUrl).origin;
  const granted = await chrome.permissions.request({
    origins: [`${origin}/*`],
  } as chrome.permissions.Permissions);
  if (!granted) throw new Error('站点授权被拒绝');
}

async function startRecording(): Promise<void> {
  if (activeTabId === null) throw new Error('没有活动标签页');
  await grantCurrentSite();
  const response = await send<{ ok: boolean; error?: string }>({
    type: 'ib:start-recording',
    tabId: activeTabId,
  });
  if (!response?.ok) throw new Error(response?.error ?? 'start failed');
  await refreshStatus();
}

async function stopRecording(): Promise<void> {
  const response = await send<{ ok: boolean; flow?: Flow; warnings?: string[]; error?: string }>({
    type: 'ib:stop-recording',
  });
  if (!response?.ok) throw new Error(response?.error ?? 'stop failed');
  await refreshStatus();
  await renderFlows();
  if (response.flow) {
    expandedFlow = response.flow.flow_id;
    await renderFlows();
  }
}

async function runFlow(flow: Flow): Promise<void> {
  if (activeTabId === null) throw new Error('没有活动标签页');
  await grantCurrentSite();
  const variables: Record<string, unknown> = {};
  for (const variable of flow.variables) {
    const value =
      variableValues.get(`${flow.flow_id}:${variable.name}`) ??
      (variable.default === undefined ? '' : String(variable.default));
    if (value !== '') variables[variable.name] = value;
  }
  const auto = Boolean(
    (document.getElementById('auto-approve') as HTMLInputElement | null)?.checked,
  );
  const response = await send<{ ok: boolean; error?: string }>({
    type: 'ib:run-flow',
    flowId: flow.flow_id,
    tabId: activeTabId,
    variables,
    autoApprove: auto,
  });
  if (!response?.ok) throw new Error(response?.error ?? 'run failed');
  await refreshStatus();
}

async function renderFlows(): Promise<void> {
  const response = await send<{ ok: boolean; flows: StoredFlow[] }>({ type: 'ib:list-flows' });
  const flows = (response?.flows ?? []).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (flows.length === 0) {
    flowsEl.replaceChildren(el('p', { className: 'muted' }, '还没有流程。先录制一段操作。'));
    return;
  }
  flowsEl.replaceChildren(
    ...flows.map((stored) => {
      const flow = stored.flow;
      const expanded = expandedFlow === flow.flow_id;
      const card = el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'row between' },
          el('strong', {}, flow.name),
          statusBadge(flow.platform),
        ),
        el(
          'div',
          { className: 'muted small' },
          `${flow.steps.length} 步 · r${flow.revision} · ${flow.app_scope.value}`,
        ),
        el(
          'div',
          { className: 'row' },
          el(
            'button',
            {
              onClick: () => {
                expandedFlow = expanded ? null : flow.flow_id;
                void renderFlows();
              },
            },
            expanded ? '收起' : '运行',
          ),
          el(
            'button',
            {
              className: 'danger',
              onClick: async () => {
                await send({ type: 'ib:delete-flow', flowId: flow.flow_id });
                await renderFlows();
              },
            },
            '删除',
          ),
        ),
        expanded
          ? el(
              'div',
              { className: 'run-form' },
              ...flow.variables.map((variable) =>
                el(
                  'label',
                  { className: 'field' },
                  el(
                    'span',
                    { className: 'muted small' },
                    `${variable.name}（${variable.type}${variable.required ? '，必填' : ''}）`,
                  ),
                  el('input', {
                    type: variable.sensitive ? 'password' : 'text',
                    placeholder: variable.sensitive ? '运行时输入，不保存' : '',
                    value: variableValues.get(`${flow.flow_id}:${variable.name}`) ?? '',
                    onInput: (event: Event) => {
                      variableValues.set(
                        `${flow.flow_id}:${variable.name}`,
                        (event.target as HTMLInputElement).value,
                      );
                    },
                  }),
                ),
              ),
              el(
                'label',
                { className: 'field' },
                el('span', { className: 'muted small' }, '自动批准 sensitive 步骤'),
                el('input', { type: 'checkbox', id: 'auto-approve' }),
              ),
              el(
                'button',
                { className: 'primary', onClick: () => void runFlow(flow).catch(showError) },
                '开始运行',
              ),
            )
          : el('span'),
      );
      return card;
    }),
  );
}

function showError(error: unknown): void {
  statusEl.append(
    el('div', { className: 'error small' }, String((error as Error).message ?? error)),
  );
}

async function boot(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url ?? '';
  const recording = runtime.status === 'recording';
  const actions = el(
    'div',
    { className: 'actions' },
    recording
      ? el(
          'button',
          { className: 'danger', onClick: () => void stopRecording().catch(showError) },
          '停止并保存',
        )
      : el(
          'button',
          { className: 'primary', onClick: () => void startRecording().catch(showError) },
          '开始录制',
        ),
    runtime.status === 'running' || runtime.status === 'paused'
      ? el(
          'button',
          { onClick: () => void send({ type: 'ib:cancel' }).then(refreshStatus) },
          '取消运行',
        )
      : el('span'),
    el('button', { onClick: () => void grantCurrentSite().catch(showError) }, '授权当前站点'),
  );
  root.replaceChildren(
    el(
      'header',
      {},
      el(
        'div',
        { className: 'brand' },
        el('span', { className: 'mark' }, 'IB'),
        el(
          'div',
          {},
          el('strong', {}, 'IntentBridge'),
          el('div', { className: 'muted tiny' }, '本地录制与重放'),
        ),
      ),
    ),
    el('div', { className: 'url muted tiny' }, activeTabUrl || '无活动页面'),
    statusEl,
    actions,
    pendingEl,
    el('h3', {}, '流程'),
    flowsEl,
    el('footer', { className: 'muted tiny' }, '密码字段不录制 · 不连接云端 · 数据留在本机'),
  );
  await refreshStatus();
  await renderFlows();
  window.setInterval(() => void refreshStatus(), 900);
}

void boot().catch(showError);
