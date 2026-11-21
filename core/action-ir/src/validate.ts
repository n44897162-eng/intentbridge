import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import formatsModule from 'ajv-formats';
import schema from '../schema/flow-1.0.0.schema.json' with { type: 'json' };
import {
  findPlaintextSecret,
  isSecretRef,
  collectSecretRefs,
} from '@intentbridge/protocol/browser';
import type {
  Condition,
  Diagnostic,
  Flow,
  Permission,
  Step,
  StepAction,
  ValidationResult,
} from './types.js';
import { MUTATING_ACTIONS } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
const addFormats = ((formatsModule as unknown as { default?: (instance: unknown) => unknown })
  .default ?? formatsModule) as unknown as (instance: unknown) => unknown;
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const ACTION_PERMISSIONS: Readonly<Record<StepAction, readonly Permission[]>> = {
  launch: ['launch'],
  activate: ['read-ui'],
  wait: ['read-ui'],
  click: ['click'],
  input: ['type'],
  select: ['select'],
  scroll: ['scroll'],
  'read-text': ['read-ui'],
  assert: ['read-ui'],
  'set-variable': [],
  branch: [],
  compensate: [],
  end: [],
};

const PASSWORD_HINT = /(pass(word|wd)?|pin|otp|one[- ]?time|密码|口令|验证码)/i;
const SECRET_REF_RE = /^secret:\/\/[a-z][a-z0-9._-]{0,63}$/;
const TEMPLATE_REF_RE = /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function diag(
  severity: Diagnostic['severity'],
  code: Diagnostic['code'],
  rule: string,
  path: string,
  message: string,
): Diagnostic {
  return { severity, code, rule, path, message };
}

function fromAjvError(error: ErrorObject): Diagnostic {
  const path = `${error.instancePath || ''}${error.params && 'missingProperty' in error.params ? `/${String(error.params.missingProperty)}` : ''}`;
  return diag(
    'error',
    'INVALID_IR',
    `schema.${error.keyword}`,
    path || '/',
    error.message ?? 'schema violation',
  );
}

function conditionTarget(condition: Condition): boolean {
  return (
    condition.kind === 'element-present' ||
    condition.kind === 'element-absent' ||
    condition.kind === 'text-matches'
  );
}

function stepPath(index: number, suffix = ''): string {
  return `/steps/${index}${suffix}`;
}

function walkStrings(
  value: unknown,
  path: string,
  visit: (text: string, path: string) => void,
): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}/${index}`, visit));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      walkStrings(item, `${path}/${key}`, visit);
    }
  }
}

function normalizeOnFailure(step: Step): {
  mode: 'stop' | 'ask-user' | 'goto-step';
  goto?: string;
} {
  const value = step.on_failure;
  if (value === undefined) return { mode: 'stop' };
  if (typeof value === 'string') return { mode: value };
  return { mode: value.mode, goto: value.goto_step_id };
}

export interface ValidateOptions {
  /** Additional gates applied before a run may start. */
  forExecution?: boolean;
  /** Runtime cap; flows above it cannot run on this installation. */
  maxSteps?: number;
  maxStepTimeoutMs?: number;
}

/**
 * Full validation: JSON Schema first, then semantic/safety rules. Returns every
 * diagnostic instead of failing fast so editors can show them inline.
 */
export function validateFlow(value: unknown, options: ValidateOptions = {}): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(diag('error', 'INVALID_IR', 'flow.not-object', '/', 'flow must be a JSON object'));
    return { ok: false, errors, warnings };
  }

  if (!validateSchema(value)) {
    for (const error of validateSchema.errors ?? []) errors.push(fromAjvError(error));
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const flow = value as Flow;
  const stepIds = new Map<string, number>();
  const variableNames = new Set<string>();
  const permissions = new Set(flow.permissions);

  // ---- app scope ---------------------------------------------------------
  const expectedKind =
    flow.platform === 'web'
      ? 'web-origin'
      : flow.platform === 'windows'
        ? 'windows-app'
        : 'android-package';
  if (flow.app_scope.kind !== expectedKind) {
    errors.push(
      diag(
        'error',
        'INVALID_IR',
        'app-scope.kind-mismatch',
        '/app_scope/kind',
        `platform ${flow.platform} requires app_scope.kind=${expectedKind}`,
      ),
    );
  }
  if (flow.app_scope.kind === 'web-origin') {
    try {
      const url = new URL(flow.app_scope.value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
      if (
        url.protocol === 'http:' &&
        !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
      ) {
        errors.push(
          diag(
            'error',
            'UNSAFE_FLOW',
            'app-scope.insecure-origin',
            '/app_scope/value',
            'plain http is only allowed for loopback origins',
          ),
        );
      }
      if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'app-scope.not-an-origin',
            '/app_scope/value',
            'web app_scope.value must be a bare origin such as https://example.com',
          ),
        );
      }
    } catch {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'app-scope.invalid-url',
          '/app_scope/value',
          'web app_scope.value must be a valid http(s) origin',
        ),
      );
    }
  }
  if (flow.app_scope.kind === 'windows-app' && !flow.app_scope.process_name) {
    errors.push(
      diag(
        'error',
        'INVALID_IR',
        'app-scope.windows-process',
        '/app_scope/process_name',
        'windows flows must pin the target process name',
      ),
    );
  }
  if (
    flow.app_scope.kind === 'android-package' &&
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(flow.app_scope.value)
  ) {
    errors.push(
      diag(
        'error',
        'INVALID_IR',
        'app-scope.android-package',
        '/app_scope/value',
        'android app_scope.value must be a package name',
      ),
    );
  }

  // ---- variables ---------------------------------------------------------
  flow.variables.forEach((variable, index) => {
    const path = `/variables/${index}`;
    if (variableNames.has(variable.name)) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'variable.duplicate',
          `${path}/name`,
          `duplicate variable ${variable.name}`,
        ),
      );
    }
    variableNames.add(variable.name);
    if (variable.sensitive && variable.default !== undefined) {
      errors.push(
        diag(
          'error',
          'UNSAFE_FLOW',
          'variable.sensitive-default',
          `${path}/default`,
          'sensitive variables must not carry a plaintext default',
        ),
      );
    }
    if (
      variable.min_length !== undefined &&
      variable.max_length !== undefined &&
      variable.min_length > variable.max_length
    ) {
      errors.push(
        diag('error', 'INVALID_IR', 'variable.length-range', path, 'min_length exceeds max_length'),
      );
    }
    if (variable.pattern !== undefined) {
      try {
        new RegExp(variable.pattern);
      } catch {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'variable.invalid-pattern',
            `${path}/pattern`,
            'invalid regex',
          ),
        );
      }
    }
  });

  // ---- flow-wide permissions / evidence ---------------------------------
  if (flow.steps.some((step) => step.target || (step.preconditions?.length ?? 0) > 0)) {
    if (!permissions.has('read-ui')) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'flow.permission-read-ui',
          '/permissions',
          'read-ui is required to observe UI',
        ),
      );
    }
  }
  const captures = flow.steps.some(
    (step) =>
      (step.evidence_policy?.capture ?? flow.defaults?.evidence_policy?.capture ?? 'target') !==
      'none',
  );
  if (captures && !permissions.has('read-screen')) {
    errors.push(
      diag(
        'error',
        'INVALID_IR',
        'flow.permission-read-screen',
        '/permissions',
        'read-screen is required when evidence screenshots are captured',
      ),
    );
  }

  // ---- steps -------------------------------------------------------------
  flow.steps.forEach((step, index) => {
    const base = stepPath(index);
    if (stepIds.has(step.id)) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'step.duplicate-id',
          `${base}/id`,
          `duplicate step id ${step.id}`,
        ),
      );
    }
    stepIds.set(step.id, index);

    const required = ACTION_PERMISSIONS[step.action] ?? [];
    for (const permission of required) {
      if (!permissions.has(permission)) {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'step.permission-missing',
            `${base}/action`,
            `action ${step.action} requires permission ${permission}`,
          ),
        );
      }
    }

    if (['click', 'input', 'select', 'read-text'].includes(step.action) && !step.target) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'step.target-required',
          `${base}/target`,
          `${step.action} needs a target`,
        ),
      );
    }
    if (MUTATING_ACTIONS.includes(step.action) && (step.postconditions?.length ?? 0) === 0) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'step.missing-postcondition',
          `${base}/postconditions`,
          `${step.action} must declare an observable postcondition; an action call is not success`,
        ),
      );
    }
    if (step.action === 'scroll') {
      const boundary = (step.params as { boundary_condition?: Condition } | undefined)
        ?.boundary_condition;
      if (!boundary) {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'step.scroll-boundary',
            `${base}/params/boundary_condition`,
            'scroll requires a boundary condition and a bounded max_attempts',
          ),
        );
      }
    }
    if (step.action === 'launch' && flow.platform === 'web') {
      const url = (step.params as { url?: string } | undefined)?.url;
      if (url) {
        try {
          const launched = new URL(url);
          if (launched.origin !== flow.app_scope.value) {
            errors.push(
              diag(
                'error',
                'UNSAFE_FLOW',
                'step.launch-origin-mismatch',
                `${base}/params/url`,
                'launch URL origin must equal app_scope.value',
              ),
            );
          }
        } catch {
          errors.push(
            diag(
              'error',
              'INVALID_IR',
              'step.launch-url',
              `${base}/params/url`,
              'invalid launch URL',
            ),
          );
        }
      }
      if (!permissions.has('navigate') && !permissions.has('launch')) {
        warnings.push(
          diag(
            'warning',
            'INVALID_IR',
            'step.launch-permission',
            `${base}/params`,
            'web launch usually needs the navigate permission',
          ),
        );
      }
    }

    const configuredTimeout = step.timeout_ms ?? flow.defaults?.timeout_ms ?? 30_000;
    if (configuredTimeout > (options.maxStepTimeoutMs ?? 120_000)) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'step.timeout-exceeds-cap',
          `${base}/timeout_ms`,
          `step timeout exceeds cap ${options.maxStepTimeoutMs ?? 120_000}ms`,
        ),
      );
    }
    if (configuredTimeout > 30_000) {
      warnings.push(
        diag(
          'warning',
          'INVALID_IR',
          'step.long-timeout',
          `${base}/timeout_ms`,
          'timeout above the 30s default; confirm this is intentional',
        ),
      );
    }

    const onFailure = normalizeOnFailure(step);
    if (onFailure.mode === 'goto-step') {
      if (!onFailure.goto) {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'step.goto-missing',
            `${base}/on_failure`,
            'goto-step needs goto_step_id',
          ),
        );
      }
    }

    if (step.compensation_step_id && step.compensation_step_id === step.id) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'step.compensation-self',
          `${base}/compensation_step_id`,
          'a step cannot compensate itself',
        ),
      );
    }

    // Evidence policy safety for sensitive steps.
    const capture =
      step.evidence_policy?.capture ?? flow.defaults?.evidence_policy?.capture ?? 'target';
    const maskText =
      step.evidence_policy?.mask_text ?? flow.defaults?.evidence_policy?.mask_text ?? true;
    const looksSensitive =
      step.risk !== undefined && step.risk !== 'normal'
        ? true
        : Boolean(
            step.target &&
            [
              step.target.anchors.semantic?.name,
              step.target.anchors.semantic?.label,
              step.target.anchors.semantic?.placeholder,
            ]
              .filter(Boolean)
              .some((text) => PASSWORD_HINT.test(text as string)),
          );
    const inputValue = (step.params as { value?: unknown } | undefined)?.value;
    const inputHasSecretRef = typeof inputValue === 'string' && isSecretRef(inputValue);
    if ((looksSensitive || inputHasSecretRef) && capture !== 'none' && !maskText) {
      errors.push(
        diag(
          'error',
          'UNSAFE_FLOW',
          'step.evidence-leaks-sensitive',
          `${base}/evidence_policy`,
          'sensitive steps must mask screenshots or disable capture',
        ),
      );
    }
    if (
      (looksSensitive || inputHasSecretRef) &&
      capture !== 'none' &&
      (step.evidence_policy?.mask_selectors?.length ?? 0) === 0
    ) {
      warnings.push(
        diag(
          'warning',
          'UNSAFE_FLOW',
          'step.evidence-mask-selectors',
          `${base}/evidence_policy`,
          'sensitive step captures should list mask_selectors',
        ),
      );
    }
    if ((step.evidence_policy?.retention_days ?? 7) > 30) {
      warnings.push(
        diag(
          'warning',
          'UNSAFE_FLOW',
          'step.evidence-retention',
          `${base}/evidence_policy`,
          'evidence retention above 30 days',
        ),
      );
    }

    // Password input heuristics + secret reference placement.
    if (step.action === 'input') {
      const value = (step.params as { value?: string } | undefined)?.value ?? '';
      const hintText = [
        step.target?.anchors.semantic?.name,
        step.target?.anchors.semantic?.label,
        step.target?.anchors.semantic?.placeholder,
      ]
        .filter(Boolean)
        .join(' ');
      if (PASSWORD_HINT.test(hintText) && !SECRET_REF_RE.test(value)) {
        const isTemplate = /^\$\{[A-Za-z][A-Za-z0-9_]*\}$/.test(value);
        const variableName = isTemplate ? value.slice(2, -1) : '';
        const variable = flow.variables.find((item) => item.name === variableName);
        if (!variable?.sensitive) {
          errors.push(
            diag(
              'error',
              'UNSAFE_FLOW',
              'input.plaintext-password',
              `${base}/params/value`,
              'password-like inputs must use secret://alias or a sensitive variable',
            ),
          );
        }
      }
    }

    // Conditions: targets + references.
    const conditionList: Array<{ condition: Condition; path: string }> = [];
    (step.preconditions ?? []).forEach((condition, i) =>
      conditionList.push({ condition, path: `${base}/preconditions/${i}` }),
    );
    (step.postconditions ?? []).forEach((condition, i) =>
      conditionList.push({ condition, path: `${base}/postconditions/${i}` }),
    );
    const params = step.params as Record<string, unknown> | undefined;
    cpCondition(params, `${base}/params`, conditionList);
    for (const { condition, path } of conditionList) {
      if (condition.kind === 'variable-compare' && !variableNames.has(condition.variable)) {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'condition.unknown-variable',
            `${path}/variable`,
            'condition references an undeclared variable',
          ),
        );
      }
      if (condition.kind === 'text-matches') {
        if (condition.matcher.type === 'regex') {
          try {
            new RegExp(condition.matcher.value);
          } catch {
            errors.push(
              diag(
                'error',
                'INVALID_IR',
                'condition.bad-regex',
                `${path}/matcher/value`,
                'invalid regex',
              ),
            );
          }
        }
      }
    }
    if (
      step.action === 'wait' &&
      conditionTarget((step.params as { condition: Condition }).condition)
    ) {
      // target condition present; nothing more
    }
    if (step.action === 'branch') {
      const branch = step.params as {
        goto_step_id: string;
        else_step_id?: string;
        condition: Condition;
      };
      if (
        !variableNames.has(
          branch.condition.kind === 'variable-compare' ? branch.condition.variable : '',
        )
      ) {
        // variable conditions checked above; branch may also use observed UI conditions
      }
    }
  });

  // ---- cross-step references --------------------------------------------
  flow.steps.forEach((step, index) => {
    const base = stepPath(index);
    const checkRef = (target: string | undefined, rule: string, path: string, what: string) => {
      if (target !== undefined && !stepIds.has(target)) {
        errors.push(diag('error', 'INVALID_IR', rule, path, `${what} ${target} does not exist`));
      }
    };
    checkRef(
      step.compensation_step_id,
      'step.compensation-missing',
      `${base}/compensation_step_id`,
      'compensation step',
    );
    checkRef(
      normalizeOnFailure(step).goto,
      'step.goto-missing-target',
      `${base}/on_failure/goto_step_id`,
      'goto step',
    );
    const params = step.params as Record<string, unknown> | undefined;
    if (step.action === 'branch' && params) {
      checkRef(
        params.goto_step_id as string,
        'branch.goto-missing-target',
        `${base}/params/goto_step_id`,
        'branch target',
      );
      checkRef(
        params.else_step_id as string | undefined,
        'branch.else-missing-target',
        `${base}/params/else_step_id`,
        'branch else target',
      );
    }
    if (step.action === 'compensate' && params) {
      checkRef(
        params.compensation_step_id as string,
        'compensate.missing-target',
        `${base}/params/compensation_step_id`,
        'compensation step',
      );
    }
  });

  // ---- templates and plaintext secrets ---------------------------------
  const declaredVariables = variableNames;
  walkStrings(flow, '', (text, path) => {
    if (typeof text !== 'string') return;
    for (const match of text.matchAll(TEMPLATE_REF_RE)) {
      const name = match[1] as string;
      if (!declaredVariables.has(name)) {
        errors.push(
          diag(
            'error',
            'INVALID_IR',
            'template.unknown-variable',
            path,
            `template references undeclared variable ${name}`,
          ),
        );
      }
    }
    if (text.startsWith('secret://')) return;
    const found = findPlaintextSecret(text);
    if (found) {
      errors.push(
        diag(
          'error',
          'UNSAFE_FLOW',
          'flow.plaintext-secret',
          path,
          `possible plaintext ${found} detected`,
        ),
      );
    }
  });

  // Secret refs are only allowed in input values.
  flow.steps.forEach((step, index) => {
    const refs = collectSecretRefs(
      step as unknown as import('@intentbridge/protocol/browser').JsonValue,
    );
    if (refs.size === 0) return;
    const allowed = step.action === 'input' || step.action === 'select';
    if (!allowed) {
      errors.push(
        diag(
          'error',
          'UNSAFE_FLOW',
          'secret.invalid-placement',
          `/steps/${index}`,
          'secret references are only allowed in input/select values',
        ),
      );
    }
    if (step.action === 'input') {
      const value = (step.params as { value?: string } | undefined)?.value ?? '';
      if (refs.size > 0 && !isSecretRef(value)) {
        warnings.push(
          diag(
            'warning',
            'UNSAFE_FLOW',
            'secret.embedded-template',
            `/steps/${index}/params/value`,
            'secret reference is embedded in a larger template; prefer an exact reference',
          ),
        );
      }
    }
  });

  // ---- execution gates ---------------------------------------------------
  if (options.forExecution) {
    if (flow.steps.length === 0) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'flow.empty',
          '/steps',
          'a runnable flow needs at least one step',
        ),
      );
    }
    const maxSteps = options.maxSteps ?? 100;
    if (flow.steps.length > maxSteps) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'flow.too-many-steps',
          '/steps',
          `flow exceeds runtime cap of ${maxSteps} steps`,
        ),
      );
    }
    if (!flow.steps.some((step) => step.action === 'end')) {
      errors.push(
        diag(
          'error',
          'INVALID_IR',
          'flow.missing-end',
          '/steps',
          'a runnable flow needs an explicit end step',
        ),
      );
    }
    const lastStep = flow.steps[flow.steps.length - 1];
    if (lastStep && lastStep.action !== 'end') {
      warnings.push(
        diag(
          'warning',
          'INVALID_IR',
          'flow.end-not-last',
          '/steps',
          'the flow does not end with an end step',
        ),
      );
    }
    if (flow.permissions.length === 0) {
      warnings.push(
        diag(
          'warning',
          'INVALID_IR',
          'flow.no-permissions',
          '/permissions',
          'flow declares no permissions',
        ),
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function cpCondition(
  params: Record<string, unknown> | undefined,
  path: string,
  out: Array<{ condition: Condition; path: string }>,
): void {
  if (!params) return;
  for (const key of ['condition', 'boundary_condition']) {
    const candidate = params[key];
    if (isCondition(candidate)) out.push({ condition: candidate, path: `${path}/${key}` });
  }
}

export function isCondition(value: unknown): value is Condition {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'element-present' ||
    kind === 'element-absent' ||
    kind === 'text-matches' ||
    kind === 'window-stable' ||
    kind === 'variable-compare' ||
    kind === 'url-matches' ||
    kind === 'app-in-foreground'
  );
}

/** Convenience gate used by hosts right before ARMING a flow. */
export function validateFlowForExecution(value: unknown, maxSteps = 100): ValidationResult {
  return validateFlow(value, { forExecution: true, maxSteps });
}
