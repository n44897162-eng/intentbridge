import { describe, expect, it } from 'vitest';
import { decryptFlowPackage, encryptFlowPackage } from '@intentbridge/web-shell';

describe('encrypted flow package', () => {
  it('round-trips and rejects manipulated KDF work factors', () => {
    const pkg = encryptFlowPackage({ schema_version: '1.0.0' }, 'correct horse battery');
    expect(decryptFlowPackage(pkg, 'correct horse battery')).toEqual({ schema_version: '1.0.0' });
    expect(() =>
      decryptFlowPackage({ ...pkg, kdf: { ...pkg.kdf, n: 1_048_576 } }, 'correct horse battery'),
    ).toThrow(/UNSUPPORTED_PACKAGE/);
    expect(() => decryptFlowPackage(pkg, 'wrong passphrase')).toThrow(/DECRYPT_FAILED/);
  });
});
