/**
 * Loopback IPC contract. Never bind a non-loopback address by default.
 * A one-time session token authorizes every request; tokens are compared in
 * constant time and expire with the host process.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const IPC_PROTOCOL_VERSION = '1.0.0' as const;

export interface IpcRequest {
  v: typeof IPC_PROTOCOL_VERSION;
  token: string;
  request_id: string;
  method: string;
  payload?: unknown;
}

export interface IpcResponse {
  v: typeof IPC_PROTOCOL_VERSION;
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface IpcSession {
  token: string;
  createdAt: number;
  /** Methods this session may call; '*' means all. */
  scopes: string[];
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function validateIpcRequest(value: unknown, session: IpcSession): string[] {
  if (typeof value !== 'object' || value === null) return ['request must be an object'];
  const req = value as Record<string, unknown>;
  const errors: string[] = [];
  if (req.v !== IPC_PROTOCOL_VERSION) errors.push('protocol version mismatch');
  if (typeof req.token !== 'string' || !timingSafeEqualString(req.token, session.token)) {
    errors.push('unauthorized: invalid session token');
  }
  if (typeof req.request_id !== 'string' || req.request_id.length < 8)
    errors.push('request_id invalid');
  if (typeof req.method !== 'string' || req.method.length === 0) errors.push('method invalid');
  if (
    session.scopes.length > 0 &&
    !session.scopes.includes('*') &&
    typeof req.method === 'string' &&
    !session.scopes.includes(req.method)
  ) {
    errors.push('unauthorized: method not in session scope');
  }
  return errors;
}

/** Rejects wildcard/localhost-adjacent binds that would expose the host. */
export function assertLoopback(host: string): void {
  const allowed = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!allowed.has(host)) {
    throw new Error(`IPC host must be loopback, got ${host}`);
  }
}
