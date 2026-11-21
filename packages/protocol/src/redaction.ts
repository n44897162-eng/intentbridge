/**
 * Redaction utilities. Used by logs, evidence, diagnostics and UI previews.
 * Secrets are addressed by alias (`secret://name`) and never by value.
 */
import type { JsonObject, JsonValue } from './engine.js';

const SENSITIVE_KEY =
  /(pass(word|wd)?|secret|token|otp|pin|card|cvv|cvc|ssn|credential|api[-_]?key|auth)/i;
const SECRET_REF = /^secret:\/\/[a-z][a-z0-9._-]{0,63}$/;
const MASK = '«redacted»';

export function isSecretRef(value: string): boolean {
  return SECRET_REF.test(value);
}

/** Extracts all `secret://alias` references from a nested document. */
export function collectSecretRefs(value: JsonValue, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (isSecretRef(value)) out.add(value.slice('secret://'.length));
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecretRefs(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectSecretRefs(item, out);
  }
  return out;
}

export interface RedactOptions {
  /** When true, any string value is masked (used for raw screen text). */
  maskAllText?: boolean;
  /** Extra key names (case-insensitive) treated as sensitive. */
  extraKeys?: readonly string[];
}

/**
 * Deeply redacts a JSON document. Secret references stay readable because the
 * alias itself is not a secret; resolved values never enter this function.
 */
export function redact<T extends JsonValue>(value: T, options: RedactOptions = {}): T {
  const extra = (options.extraKeys ?? []).map((k) => k.toLowerCase());
  const walk = (node: JsonValue, key?: string): JsonValue => {
    if (typeof node === 'string') {
      if (isSecretRef(node)) return node;
      if (options.maskAllText) return MASK;
      return node;
    }
    if (typeof node === 'number' || typeof node === 'boolean' || node === null) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item));
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) {
      const sensitive = SENSITIVE_KEY.test(k) || extra.includes(k.toLowerCase());
      out[k] = sensitive && typeof v !== 'string' ? MASK : sensitive ? MASK : walk(v, k);
    }
    return out;
  };
  return walk(value) as T;
}

/** Creates a human-readable, redacted parameter preview for approvals/UI. */
export function previewParams(params: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      if (isSecretRef(value)) out[key] = value;
      else if (SENSITIVE_KEY.test(key)) out[key] = MASK;
      else out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else {
      out[key] = redact(value, { extraKeys: [key] });
    }
  }
  return out;
}

/** Truncates untrusted platform diagnostics before they reach logs. */
export function safeDiagnostic(text: string | undefined, max = 300): string {
  if (!text) return '';
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

/** Patterns that look like plaintext secrets accidentally pasted into a flow. */
export const PLAINTEXT_SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'credit-card-like', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/ },
];

export function findPlaintextSecret(text: string): string | null {
  for (const { name, pattern } of PLAINTEXT_SECRET_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}
