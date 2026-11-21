/** Builder helpers shared by recorders and the editor. */
import { FLOW_SCHEMA_VERSION } from './types.js';
import type {
  AppScope,
  Flow,
  FlowVariable,
  Platform,
  Permission,
  Risk,
  Step,
  StepAction,
  StepParamsMap,
  Target,
} from './types.js';

let counter = 0;

export function newId(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface CreateFlowOptions {
  name: string;
  platform: Platform;
  appScope: AppScope;
  createdBy?: string;
  description?: string;
  variables?: FlowVariable[];
  permissions?: Permission[];
}

export function createFlow(options: CreateFlowOptions): Flow {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    flow_id: newId('flow'),
    name: options.name,
    description: options.description ?? '',
    platform: options.platform,
    app_scope: options.appScope,
    variables: options.variables ?? [],
    permissions: options.permissions ?? ['read-ui', 'read-screen', 'click', 'type'],
    steps: [],
    created_by: options.createdBy ?? 'local-device',
    revision: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function createStep<A extends StepAction>(
  action: A,
  params: StepParamsMap[A],
  options: {
    name?: string;
    target?: Target;
    preconditions?: Step['preconditions'];
    postconditions?: Step['postconditions'];
    risk?: Risk;
    id?: string;
    timeout_ms?: number;
    on_failure?: Step['on_failure'];
    evidence_policy?: Step['evidence_policy'];
  } = {},
): Step<A> {
  return {
    id: options.id ?? newId('step'),
    action,
    name: options.name,
    target: options.target ?? null,
    preconditions: options.preconditions ?? [],
    postconditions: options.postconditions ?? [],
    timeout_ms: options.timeout_ms,
    on_failure: options.on_failure ?? 'stop',
    risk: options.risk ?? 'normal',
    params,
    ...(options.evidence_policy ? { evidence_policy: options.evidence_policy } : {}),
  };
}

export function appendStep(flow: Flow, step: Step): Flow {
  flow.steps.push(step);
  flow.updated_at = new Date().toISOString();
  return flow;
}

export function addPermission(flow: Flow, ...permissions: Permission[]): Flow {
  for (const permission of permissions) {
    if (!flow.permissions.includes(permission)) flow.permissions.push(permission);
  }
  return flow;
}

export function nextRevision(flow: Flow): Flow {
  const copy = JSON.parse(JSON.stringify(flow)) as Flow;
  copy.revision += 1;
  copy.updated_at = new Date().toISOString();
  return copy;
}
