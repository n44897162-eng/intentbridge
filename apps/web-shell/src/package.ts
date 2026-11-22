/**
 * Encrypted flow packages. The passphrase never leaves the request; the key is
 * derived with scrypt and the archive is AES-256-GCM.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const PACKAGE_FORMAT = 'intentbridge.flow';
export const PACKAGE_VERSION = 1;

export interface EncryptedPackage {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  cipher: 'aes-256-gcm';
  kdf: { name: 'scrypt'; salt: string; n: number; r: number; p: number };
  iv: string;
  tag: string;
  ciphertext: string;
  created_at: string;
}

const N = 16_384;
const R = 8;
const P = 1;
const AAD = Buffer.from(`${PACKAGE_FORMAT}:${PACKAGE_VERSION}`, 'utf8');

export function isEncryptedPackage(value: unknown): value is EncryptedPackage {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Record<string, unknown>;
  return (
    doc.format === PACKAGE_FORMAT &&
    doc.version === PACKAGE_VERSION &&
    typeof doc.ciphertext === 'string'
  );
}

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('PASSPHRASE_TOO_SHORT');
  }
  return scryptSync(passphrase, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
}

export function encryptFlowPackage(flow: unknown, passphrase: string): EncryptedPackage {
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt, N, R, P);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(flow), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', salt: salt.toString('base64'), n: N, r: R, p: P },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    created_at: new Date().toISOString(),
  };
}

export function decryptFlowPackage(pkg: EncryptedPackage, passphrase: string): unknown {
  if (!isEncryptedPackage(pkg)) throw new Error('INVALID_PACKAGE');
  if (pkg.cipher !== 'aes-256-gcm' || pkg.kdf?.name !== 'scrypt')
    throw new Error('UNSUPPORTED_PACKAGE');
  // Never accept attacker-controlled KDF work factors: a huge N would let a
  // malicious package exhaust memory/CPU before authentication.
  if (pkg.kdf.n !== N || pkg.kdf.r !== R || pkg.kdf.p !== P) {
    throw new Error('UNSUPPORTED_PACKAGE');
  }
  const salt = Buffer.from(pkg.kdf.salt, 'base64');
  const key = deriveKey(passphrase, salt, pkg.kdf.n, pkg.kdf.r, pkg.kdf.p);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(pkg.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(pkg.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(pkg.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new Error('DECRYPT_FAILED');
  }
}
