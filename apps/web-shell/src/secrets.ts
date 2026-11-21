/**
 * Local development secret store (Linux). Values are AES-256-GCM encrypted with
 * a device key kept outside the database (0600). Production adapters use
 * Android Keystore / Windows DPAPI / browser secure storage; only aliases ever
 * leave this module.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from './db.js';

const ALIAS = /^[a-z][a-z0-9._-]{0,63}$/;

function loadKey(dataDir: string): Buffer {
  const env = process.env.IB_SECRET_KEY;
  if (env) {
    const decoded = Buffer.from(env, 'base64');
    if (decoded.length === 32) return decoded;
    throw new Error('IB_SECRET_KEY must be 32 bytes of base64');
  }
  mkdirSync(join(dataDir, 'keystore'), { recursive: true });
  const path = join(dataDir, 'keystore', 'device.key');
  if (existsSync(path)) {
    const decoded = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (decoded.length !== 32) throw new Error('device key is corrupt');
    return decoded;
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return key;
}

export class LocalSecretStore {
  private readonly key: Buffer;
  private readonly db: AppDatabase;

  constructor(dataDir: string, db: AppDatabase) {
    this.key = loadKey(dataDir);
    this.db = db;
  }

  static validAlias(alias: string): boolean {
    return ALIAS.test(alias);
  }

  set(alias: string, value: string): void {
    if (!ALIAS.test(alias)) throw new Error('INVALID_ALIAS');
    if (typeof value !== 'string' || value.length === 0) throw new Error('EMPTY_SECRET');
    if (value.length > 4096) throw new Error('SECRET_TOO_LONG');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.db.setSecret(
      alias,
      encrypted.toString('base64'),
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
    );
  }

  get(alias: string): string {
    const stored = this.db.getSecret(alias);
    if (!stored) throw new Error('SECRET_NOT_FOUND');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(stored.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(stored.cipher, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('SECRET_DECRYPT_FAILED');
    }
  }

  list(): Array<{ alias: string; created_at: string }> {
    return this.db.listSecrets();
  }

  delete(alias: string): boolean {
    return this.db.deleteSecret(alias);
  }
}
