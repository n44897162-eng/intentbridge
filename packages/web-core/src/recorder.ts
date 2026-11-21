/**
 * Turns a browser recording into a validated Action IR draft. Postconditions
 * are inferred from observable DOM changes; never from "the click returned".
 */
import type {
  Condition,
  Flow,
  FlowVariable,
  Permission,
  Risk,
  Step,
  StepAction,
  Target,
} from '@intentbridge/action-ir';
import type { PageCandidate, RecorderEvent } from './dom-snapshot.js';

export interface Recording {
  events: RecorderEvent[];
  warnings: string[];
  started_at: number;
  stopped_at: number;
}

export interface BuildOptions {
  name?: string;
  createdBy?: string;
  /** Test ids seen before recording started, used to detect "new" elements. */
  initialTestIds?: string[];
  /** Fallback step timeout (ms). */
  timeoutMs?: number;
}

export interface BuildResult {
  flow: Flow;
  warnings: string[];
  testIds: string[];
}

const DANGEROUS = /(delete|remove|pay|purchase|transfer|submit order|删除|支付|转账|下单|清空)/i;

function anchorsFrom(candidate: PageCandidate): Target {
  const semantic = candidate.semantic ?? {};
  const anchors: Target['anchors'] = {
    semantic: {
      ...(semantic.role ? { role: semantic.role } : {}),
      ...(semantic.name ? { name: semantic.name } : {}),
      ...(semantic.label ? { label: semantic.label } : {}),
      ...(semantic.placeholder ? { placeholder: semantic.placeholder } : {}),
      ...(semantic.test_id ? { test_id: semantic.test_id } : {}),
      ...(semantic.control_type ? { control_type: semantic.control_type } : {}),
    },
    ...(candidate.native_identity
      ? { native_identity: candidate.native_identity as Target['anchors']['native_identity'] }
      : {}),
    ...(candidate.structure?.path
      ? { structure: { path: candidate.structure.path.slice(-6) } }
      : {}),
    ...(candidate.visual?.norm_rect
      ? {
          visual: {
            norm_rect: candidate.visual.norm_rect,
            ...(candidate.visual.viewport ? { viewport: candidate.visual.viewport } : {}),
            ...(candidate.visual.device_scale
              ? { device_scale: candidate.visual.device_scale }
              : {}),
          },
        }
      : {}),
  };
  return { anchors, confidence: { mode: 'balanced' } };
}

function targetFromCandidate(candidate: PageCandidate): Target {
  return anchorsFrom(candidate);
}

function elementPresent(candidate: PageCandidate): Condition {
  const target = targetFromCandidate(candidate);
  return { kind: 'element-present', target };
}

function urlMatches(url: string): Condition | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === '/') return null;
    return { kind: 'url-matches', pattern: parsed.pathname, match_type: 'contains' };
  } catch {
    return null;
  }
}

function windowStable(min = 250): Condition {
  return { kind: 'window-stable', min_stable_ms: min };
}

function riskOf(event: RecorderEvent): Risk {
  const text = [event.candidate.semantic?.name, event.candidate.text].filter(Boolean).join(' ');
  return DANGEROUS.test(text) ? 'sensitive' : 'normal';
}

/** Infers a postcondition from the recorded after-snapshot. */
function inferPostcondition(
  event: RecorderEvent,
  seenTestIds: Set<string>,
  warnings: string[],
): Condition {
  if (!event.after) {
    warnings.push(
      `step ${event.candidate.semantic?.name ?? event.type}: no after-snapshot; using window stability`,
    );
    return windowStable();
  }
  if (event.after.url !== event.url) {
    const condition = urlMatches(event.after.url);
    if (condition) return condition;
  }
  const newTestIds = event.after.testIds.filter((testId) => !seenTestIds.has(testId));
  for (const testId of newTestIds) {
    const candidate = event.after.candidates_by_testid[testId];
    if (candidate) {
      seenTestIds.add(testId);
      return elementPresent(candidate);
    }
  }
  for (const testId of event.after.testIds) seenTestIds.add(testId);
  return windowStable();
}

function mergeConsecutiveInputs(events: RecorderEvent[], warnings: string[]): RecorderEvent[] {
  const merged: RecorderEvent[] = [];
  for (const event of events) {
    if (event.password) {
      warnings.push('password-like input skipped');
      continue;
    }
    if (event.type === 'input' && event.value === '') continue;
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.type === 'input' &&
      event.type === 'input' &&
      previous.candidate.candidate_id === event.candidate.candidate_id &&
      event.taken_at - previous.taken_at < 1000
    ) {
      merged[merged.length - 1] = { ...event, after: event.after ?? previous.after };
      continue;
    }
    merged.push(event);
  }
  return merged;
}

export function buildFlowFromRecording(
  recording: Recording,
  options: BuildOptions = {},
): BuildResult {
  const warnings = [...recording.warnings];
  const events = mergeConsecutiveInputs(recording.events, warnings);
  if (events.length === 0) {
    throw new Error('recording contains no usable events');
  }
  const first = events[0] as RecorderEvent;
  let origin = 'http://127.0.0.1:4317';
  try {
    origin = new URL(first.url).origin;
  } catch {
    warnings.push('could not parse the recording origin; using fixture origin');
  }
  const seenTestIds = new Set<string>(options.initialTestIds ?? []);
  for (const event of events) {
    if (event.after) for (const testId of event.after.testIds) seenTestIds.add(testId);
  }
  // Rebuild in order so "new test id" detection is meaningful.
  const orderedSeen = new Set<string>(options.initialTestIds ?? []);

  const steps: Step[] = [];
  const launchTarget = events.find((event) => event.type === 'input' || event.type === 'click');
  steps.push({
    id: 'launch',
    action: 'launch',
    name: '打开页面',
    risk: 'normal',
    postconditions: launchTarget ? [elementPresent(launchTarget.candidate)] : [windowStable()],
    params: { app_id: origin, url: first.url, wait_ready: true },
  });

  let index = 0;
  for (const event of events) {
    index += 1;
    const action: StepAction = event.type === 'input' ? 'input' : 'click';
    const step: Step = {
      id: `step-${index}`,
      action,
      name:
        (action === 'input' ? '输入：' : '点击：') +
        (event.candidate.semantic?.name ??
          event.candidate.semantic?.test_id ??
          event.candidate.candidate_id),
      target: targetFromCandidate(event.candidate),
      risk: riskOf(event),
      timeout_ms: options.timeoutMs ?? 30_000,
      evidence_policy: {
        capture: 'target',
        save_on: 'failure',
        retention_days: 7,
        mask_text: true,
      },
      postconditions: [inferPostcondition(event, orderedSeen, warnings)],
      ...(action === 'input'
        ? { params: { value: event.value ?? '', clear_first: true, typing_delay_ms: 0 } }
        : { params: { button: 'left', click_count: 1 } }),
    };
    steps.push(step);
  }
  steps.push({ id: 'done', action: 'end', name: '完成', params: { status: 'success' } });

  const usedActions = new Set(steps.map((step) => step.action));
  const permissions = new Set<Permission>(['read-ui', 'read-screen']);
  if (usedActions.has('click')) permissions.add('click');
  if (usedActions.has('input')) permissions.add('type');
  permissions.add('launch');
  permissions.add('navigate');

  const variables: FlowVariable[] = [];
  const flow: Flow = {
    schema_version: '1.0.0',
    flow_id: crypto.randomUUID(),
    name: options.name ?? '录制的 Web 流程',
    description: '由 Web 录制器生成，请在编辑器中检查锚点与后置条件。',
    platform: 'web',
    app_scope: { kind: 'web-origin', value: origin },
    variables,
    permissions: [...permissions],
    steps,
    created_by: options.createdBy ?? 'web-recorder',
    revision: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    labels: { source: 'recording' },
  };

  // Validation is deliberately done by the host (Node/Ajv or the Rust engine)
  // so the browser bundle never needs a schema compiler / unsafe-eval.
  for (const step of flow.steps) {
    if (step.action !== 'end' && (step.postconditions?.length ?? 0) === 0) {
      step.postconditions = [windowStable()];
      warnings.push(`step ${step.id}: no postcondition could be inferred; using window stability`);
    }
  }
  const testIds = Array.from(
    new Set(events.flatMap((event) => event.candidate.semantic?.test_id ?? [])),
  );
  return { flow, warnings, testIds };
}
