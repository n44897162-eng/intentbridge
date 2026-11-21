/**
 * Variable templates. Only `${name}` substitution is supported: no expressions,
 * no evaluation, no arbitrary code. Secrets are resolved separately and never
 * returned to logs.
 */
import { isSecretRef } from '@intentbridge/protocol/browser';

export const TEMPLATE_REF = /\$\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;

export type VariableValue = string | number | boolean | null;

export interface InterpolationResult {
  value: string;
  missing: string[];
}

export function extractTemplateRefs(text: string): string[] {
  return Array.from(text.matchAll(TEMPLATE_REF), (match) => match[1] as string);
}

export function interpolate(
  text: string,
  values: Readonly<Record<string, VariableValue>>,
): InterpolationResult {
  const missing = new Set<string>();
  const value = text.replace(TEMPLATE_REF, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      missing.add(name);
      return '';
    }
    return String(values[name] ?? '');
  });
  return { value, missing: [...missing] };
}

export interface DeepInterpolationResult {
  value: unknown;
  missing: Array<{ path: string; name: string }>;
}

export function interpolateDeep(
  input: unknown,
  values: Readonly<Record<string, VariableValue>>,
  path = '',
): DeepInterpolationResult {
  const missing: Array<{ path: string; name: string }> = [];
  const walk = (node: unknown, current: string): unknown => {
    if (typeof node === 'string') {
      const result = interpolate(node, values);
      result.missing.forEach((name) => missing.push({ path: current, name }));
      return result.value;
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${current}/${index}`));
    if (typeof node === 'object' && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = walk(item, `${current}/${key}`);
      return out;
    }
    return node;
  };
  return { value: walk(input, path), missing };
}

/** Coerces a resolved string back to the declared variable type. */
export function coerceVariable(
  value: string,
  type: 'string' | 'number' | 'boolean' | 'date',
): string | number | boolean {
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`value is not a number: ${value.slice(0, 40)}`);
    return n;
  }
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`value is not a boolean: ${value.slice(0, 40)}`);
  }
  return value;
}

export interface SecretResolver {
  /** Returns the secret value; rejects with SECRET_NOT_FOUND semantics. */
  get(alias: string): Promise<string>;
}

export function secretAlias(value: string): string | null {
  return isSecretRef(value) ? value.slice('secret://'.length) : null;
}

export interface ResolvedInput {
  value: string;
  used_secret: string | null;
}

/**
 * Resolves a step input value. Exact secret references are fetched from the
 * platform store; embedded references are rejected upstream.
 */
export async function resolveInputValue(
  template: string,
  variables: Readonly<Record<string, VariableValue>>,
  secrets?: SecretResolver,
): Promise<ResolvedInput> {
  const alias = secretAlias(template);
  if (alias) {
    if (!secrets) throw new Error('SECRET_NOT_FOUND: no secret store configured');
    const value = await secrets.get(alias);
    return { value, used_secret: alias };
  }
  const { value, missing } = interpolate(template, variables);
  if (missing.length > 0) throw new Error(`missing variables: ${missing.join(', ')}`);
  return { value, used_secret: null };
}
