import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeProxyProfile,
  ProxyStore,
  type ProxySecretStorage,
} from '../src/main/proxy/proxy-store';

const fakeSecretStorage: ProxySecretStorage = {
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  isEncryptionAvailable: () => true,
};

describe('proxy profile store', () => {
  it('rejects invalid ports, missing credentials, and oversized fields', () => {
    expect(() =>
      normalizeProxyProfile({ address: 'proxy.example', port: 0, protocol: 'http' }),
    ).toThrow(/1–65535/);
    expect(() =>
      normalizeProxyProfile({ address: 'proxy.example', port: 443, protocol: 'vless' }),
    ).toThrow(/UUID/);
    expect(() =>
      normalizeProxyProfile({ address: 'x'.repeat(254), port: 443, protocol: 'http' }),
    ).toThrow(/服务器地址/);
  });

  it('persists credentials separately from profile metadata and decrypts on demand', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-proxy-store-'));
    const store = new ProxyStore(userDataPath, fakeSecretStorage);
    const view = store.saveProfile({
      address: 'proxy.example',
      credentials: { password: 'synthetic-secret', username: 'alice' },
      id: 'profile-one',
      port: 8443,
      protocol: 'http',
      remark: '示例节点',
      tls: true,
    });
    expect(view.scope).toEqual({ application: false, cli: true });
    expect(view.profiles[0]?.hasCredentials).toBe(true);
    const metadata = readFileSync(path.join(userDataPath, 'proxy', 'profiles.json'), 'utf8');
    expect(metadata).not.toContain('synthetic-secret');
    expect(metadata).not.toContain('alice');
    expect(store.getProfile('profile-one')?.credentials).toEqual({
      password: 'synthetic-secret',
      username: 'alice',
    });
  });

  it('fails closed when OS encryption is unavailable', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-proxy-store-'));
    const store = new ProxyStore(userDataPath, {
      ...fakeSecretStorage,
      isEncryptionAvailable: () => false,
    });
    expect(() =>
      store.saveProfile({
        address: 'proxy.example',
        credentials: { password: 'secret' },
        port: 443,
        protocol: 'trojan',
      }),
    ).toThrow(/加密/);
  });
});
