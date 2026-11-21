/**
 * Unified error codes (task book §8.2) plus documented extensions.
 *
 * Every platform error must be mapped onto one of these codes while preserving
 * the original diagnostic in `detail`. UI copy must never leak page contents.
 */
export const ERROR_CODES = [
  // Contract / lifecycle
  'INVALID_IR',
  'MIGRATION_FAILED',
  'INVALID_STATE',
  'RUNTIME_LIMIT_EXCEEDED',
  'UNSUPPORTED_CAPABILITY',
  // Targeting
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'STALE_TARGET',
  'APP_SCOPE_VIOLATION',
  // Authorization / safety
  'PERMISSION_DENIED',
  'APPROVAL_REQUIRED',
  'UNSAFE_FLOW',
  'SENSITIVE_DATA_BLOCKED',
  // Conditions
  'PRECONDITION_FAILED',
  'POSTCONDITION_FAILED',
  'TIMEOUT',
  // Outcome / control flow
  'USER_CANCELLED',
  'OUTCOME_UNKNOWN',
  // Infrastructure
  'SECRET_NOT_FOUND',
  'EVIDENCE_WRITE_FAILED',
  'EVIDENCE_STORAGE_FULL',
  'STORAGE_FAILURE',
  'IPC_UNAUTHORIZED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorCodeSpec {
  readonly code: ErrorCode;
  /** Whether an automatic retry is ever permissible for this code. */
  readonly retryable: boolean;
  /** Whether the run may continue after a human decision. */
  readonly recoverable: boolean;
  readonly category: 'contract' | 'targeting' | 'safety' | 'condition' | 'control' | 'infra';
  readonly doc: string;
}

export const ERROR_SPECS: Readonly<Record<ErrorCode, ErrorCodeSpec>> = {
  INVALID_IR: {
    code: 'INVALID_IR',
    retryable: false,
    recoverable: false,
    category: 'contract',
    doc: 'Flow failed schema or semantic validation; execution is forbidden.',
  },
  MIGRATION_FAILED: {
    code: 'MIGRATION_FAILED',
    retryable: false,
    recoverable: false,
    category: 'contract',
    doc: 'A schema migration step failed; the original document was not modified.',
  },
  INVALID_STATE: {
    code: 'INVALID_STATE',
    retryable: false,
    recoverable: false,
    category: 'contract',
    doc: 'An operation was requested that is illegal in the current state.',
  },
  RUNTIME_LIMIT_EXCEEDED: {
    code: 'RUNTIME_LIMIT_EXCEEDED',
    retryable: false,
    recoverable: false,
    category: 'contract',
    doc: 'Max steps, runtime, retries or branch jumps exceeded.',
  },
  UNSUPPORTED_CAPABILITY: {
    code: 'UNSUPPORTED_CAPABILITY',
    retryable: false,
    recoverable: false,
    category: 'contract',
    doc: 'The target platform cannot provide this action or anchor type.',
  },
  TARGET_NOT_FOUND: {
    code: 'TARGET_NOT_FOUND',
    retryable: true,
    recoverable: true,
    category: 'targeting',
    doc: 'No candidate satisfied the minimum evidence threshold.',
  },
  TARGET_AMBIGUOUS: {
    code: 'TARGET_AMBIGUOUS',
    retryable: false,
    recoverable: true,
    category: 'targeting',
    doc: 'Multiple candidates scored near-identically; human disambiguation required.',
  },
  STALE_TARGET: {
    code: 'STALE_TARGET',
    retryable: true,
    recoverable: true,
    category: 'targeting',
    doc: 'The previously resolved platform node is no longer attached; re-resolve.',
  },
  APP_SCOPE_VIOLATION: {
    code: 'APP_SCOPE_VIOLATION',
    retryable: false,
    recoverable: true,
    category: 'safety',
    doc: 'Foreground app/page left the flow app_scope; the run must pause.',
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    retryable: false,
    recoverable: true,
    category: 'safety',
    doc: 'The flow did not declare the permission required by this action.',
  },
  APPROVAL_REQUIRED: {
    code: 'APPROVAL_REQUIRED',
    retryable: false,
    recoverable: true,
    category: 'safety',
    doc: 'A sensitive or irreversible step needs an explicit human approval.',
  },
  UNSAFE_FLOW: {
    code: 'UNSAFE_FLOW',
    retryable: false,
    recoverable: false,
    category: 'safety',
    doc: 'Flow violates a hard safety rule (plaintext secret, orphan compensation, ...).',
  },
  SENSITIVE_DATA_BLOCKED: {
    code: 'SENSITIVE_DATA_BLOCKED',
    retryable: false,
    recoverable: true,
    category: 'safety',
    doc: 'Sensitive output could not be stored/transmitted under the evidence policy.',
  },
  PRECONDITION_FAILED: {
    code: 'PRECONDITION_FAILED',
    retryable: true,
    recoverable: true,
    category: 'condition',
    doc: 'A declared precondition did not become true before its timeout.',
  },
  POSTCONDITION_FAILED: {
    code: 'POSTCONDITION_FAILED',
    retryable: false,
    recoverable: true,
    category: 'condition',
    doc: 'An action completed but its observable success condition did not hold.',
  },
  TIMEOUT: {
    code: 'TIMEOUT',
    retryable: true,
    recoverable: true,
    category: 'condition',
    doc: 'The step deadline elapsed without a conclusive observation.',
  },
  USER_CANCELLED: {
    code: 'USER_CANCELLED',
    retryable: false,
    recoverable: false,
    category: 'control',
    doc: 'The user cancelled the run; side effects already produced are recorded.',
  },
  OUTCOME_UNKNOWN: {
    code: 'OUTCOME_UNKNOWN',
    retryable: false,
    recoverable: true,
    category: 'control',
    doc: 'The result of an external write cannot be determined; never replay blindly.',
  },
  SECRET_NOT_FOUND: {
    code: 'SECRET_NOT_FOUND',
    retryable: false,
    recoverable: true,
    category: 'infra',
    doc: 'The referenced secret alias is absent from the platform secret store.',
  },
  EVIDENCE_WRITE_FAILED: {
    code: 'EVIDENCE_WRITE_FAILED',
    retryable: true,
    recoverable: true,
    category: 'infra',
    doc: 'Evidence could not be written; required audit evidence blocks sensitive actions.',
  },
  EVIDENCE_STORAGE_FULL: {
    code: 'EVIDENCE_STORAGE_FULL',
    retryable: false,
    recoverable: true,
    category: 'infra',
    doc: 'Evidence storage quota reached; new evidence writes stop and warn.',
  },
  STORAGE_FAILURE: {
    code: 'STORAGE_FAILURE',
    retryable: false,
    recoverable: false,
    category: 'infra',
    doc: 'Local database or append-only log is unavailable.',
  },
  IPC_UNAUTHORIZED: {
    code: 'IPC_UNAUTHORIZED',
    retryable: false,
    recoverable: false,
    category: 'infra',
    doc: 'IPC session token missing, expired or replayed.',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    retryable: false,
    recoverable: false,
    category: 'infra',
    doc: 'Unexpected internal failure; a diagnostic bundle should be exported.',
  },
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Serializable error shape crossing the IPC boundary. */
export interface BridgeError {
  code: ErrorCode;
  message: string;
  /** Non-sensitive structured facts, e.g. step id, candidate count, platform. */
  detail?: Record<string, string | number | boolean | null>;
  /** Original platform diagnostic (may contain sensitive text; never shown raw). */
  platform_detail?: string;
  retryable?: boolean;
}

export function makeError(
  code: ErrorCode,
  message: string,
  detail?: BridgeError['detail'],
): BridgeError {
  return {
    code,
    message,
    retryable: ERROR_SPECS[code].retryable,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Maps platform-native error diagnostics onto the unified code. Platforms keep
 * their original string, but callers must treat it as untrusted/sensitive.
 */
export function mapPlatformError(
  platform: 'web' | 'windows' | 'android',
  native: { code?: string; message?: string },
): BridgeError {
  const raw = `${native.code ?? ''} ${native.message ?? ''}`.toLowerCase();
  const table: Array<[RegExp, ErrorCode]> = [
    [/stale|detached|nodetached|disconnected/, 'STALE_TARGET'],
    [/not\s*found|no\s*match|no\s*node/, 'TARGET_NOT_FOUND'],
    [/ambiguous|multiple\s*match/, 'TARGET_AMBIGUOUS'],
    [/out\s*of\s*scope|foreign\s*origin|wrong\s*window|wrong\s*package/, 'APP_SCOPE_VIOLATION'],
    [/denied|not\s*allowed|permission/, 'PERMISSION_DENIED'],
    [/timeout|timed\s*out/, 'TIMEOUT'],
    [/cancell?ed|aborted/, 'USER_CANCELLED'],
    [/unsupported|not\s*implemented/, 'UNSUPPORTED_CAPABILITY'],
    [/unknown|indeterminate/, 'OUTCOME_UNKNOWN'],
  ];
  for (const [pattern, code] of table) {
    if (pattern.test(raw)) {
      return {
        code,
        message: `Platform reported ${code}`,
        platform_detail: `${platform}:${native.code ?? ''}:${(native.message ?? '').slice(0, 300)}`,
        retryable: ERROR_SPECS[code].retryable,
      };
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Unclassified platform failure',
    platform_detail: `${platform}:${native.code ?? ''}:${(native.message ?? '').slice(0, 300)}`,
    retryable: false,
  };
}
