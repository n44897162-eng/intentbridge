/** Deterministic canonical JSON + hashing for revisions, diffs and signatures. */
import { sha256Hex } from './sha256.js';

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new Error('canonical JSON cannot contain non-finite numbers');
      return Object.is(value, -0) ? '0' : String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      throw new Error('canonical JSON cannot contain undefined');
    case 'bigint':
      throw new Error('canonical JSON cannot contain bigint');
    case 'object': {
      if (seen.has(value as object)) throw new Error('canonical JSON cannot contain cycles');
      seen.add(value as object);
      let out: string;
      if (Array.isArray(value)) {
        out = `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
      } else {
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        out = `{${entries
          .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, seen)}`)
          .join(',')}}`;
      }
      seen.delete(value as object);
      return out;
    }
    default:
      throw new Error(`canonical JSON cannot contain ${typeof value}`);
  }
}

/** Stable serialization: object keys sorted, arrays preserved, no whitespace. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet());
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Pretty, readable export used by the editor's expert JSON view. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

/** Minimal structural diff over canonical JSON (read-only, no merge). */
export function diffJson(left: unknown, right: unknown, base = ''): JsonPatchOperation[] {
  const patches: JsonPatchOperation[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObject(left) && isObject(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const path = `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!(key in left)) patches.push({ op: 'add', path, value: right[key] });
      else if (!(key in right)) patches.push({ op: 'remove', path });
      else patches.push(...diffJson(left[key], right[key], path));
    }
    return patches;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    patches.push({ op: 'replace', path: base || '/', value: right });
  }
  return patches;
}
