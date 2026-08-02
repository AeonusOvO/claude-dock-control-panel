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
    expect(view.scope).toEqual({ application: false, cli: true, conversation: false });
    expect(view.profiles[0]?.hasCredentials).toBe(true);
    const metadata = readFileSync(path.join(userDataPath, 'proxy', 'profiles.json'), 'utf8');
    expect(metadata).not.toContain('synthetic-secret');
    expect(metadata).not.toContain('alice');
    expect(store.getProfile('profile-one')?.credentials).toEqual({
      password: 'synthetic-secret',
      username: 'alice',
    });
  });

  it('round-trips REALITY transport options and rejects a REALITY node without a public key', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-proxy-store-'));
    const store = new ProxyStore(userDataPath, fakeSecretStorage);
    const view = store.saveProfile({
      address: '64.64.253.190',
      credentials: { uuid: 'cdd66f7e-3d8e-4751-c22f-069f198f7539' },
      fingerprint: 'firefox',
      flow: 'xtls-rprx-vision',
      id: 'vless-reality',
      port: 443,
      protocol: 'vless',
      publicKey: '21GGhV4uBlCJ16U3-i8dTvR6S88dhp2qkBKqbR3xLy4',
      remark: 'vless-reality',
      security: 'reality',
      serverName: 'iosapps.itunes.apple.com',
      transport: 'tcp',
    });
    expect(view.profiles[0]).toMatchObject({
      fingerprint: 'firefox',
      flow: 'xtls-rprx-vision',
      publicKey: '21GGhV4uBlCJ16U3-i8dTvR6S88dhp2qkBKqbR3xLy4',
      security: 'reality',
      serverName: 'iosapps.itunes.apple.com',
    });
    expect(() =>
      store.saveProfile({
        address: 'proxy.example',
        credentials: { uuid: 'cdd66f7e-3d8e-4751-c22f-069f198f7539' },
        port: 443,
        protocol: 'vless',
        security: 'reality',
      }),
    ).toThrow(/公钥/);
  });

  it('encrypts subscription URLs and atomically replaces the subscription node set', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'claudedock-proxy-store-'));
    const store = new ProxyStore(userDataPath, fakeSecretStorage);
    const subscription = {
      id: 'subscription-example',
      label: '示例订阅',
      url: 'https://subscription.example/feed?token=private-token',
    };
    let view = store.replaceSubscription(subscription, [
      { address: 'one.example', id: 'node-one', port: 443, protocol: 'http' },
      { address: 'two.example', id: 'node-two', port: 443, protocol: 'socks' },
    ]);
    expect(view.subscriptions).toEqual([
      expect.objectContaining({ id: subscription.id, profileCount: 2 }),
    ]);
    const metadata = readFileSync(path.join(userDataPath, 'proxy', 'profiles.json'), 'utf8');
    expect(metadata).not.toContain('private-token');
    expect(metadata).not.toContain(subscription.url);
    expect(store.getSubscriptionSources()).toEqual([subscription]);

    view = store.replaceSubscription(subscription, [
      { address: 'three.example', id: 'node-three', port: 443, protocol: 'http' },
    ]);
    expect(view.profiles.map(({ id }) => id)).toEqual(['node-three']);
    expect(view.subscriptions[0]?.profileCount).toBe(1);
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
