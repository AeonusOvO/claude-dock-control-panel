import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applicationProxyRules,
  applicationProxyUrl,
  buildApplicationProxyEnvironment,
  parseApplicationProxyCandidate,
} from '../../src/main/proxy/application-proxy';
import {
  ApplicationProxyStore,
  type ApplicationProxySecretStorage,
} from '../../src/main/proxy/application-proxy-store';
import type { ApplicationProxyView } from '../../src/shared/contracts';

const temporaryDirectories: string[] = [];
const createDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-application-proxy-'));
  temporaryDirectories.push(directory);
  return directory;
};
const secretStorage: ApplicationProxySecretStorage = {
  decryptString: (value) => Buffer.from(value.toString('utf8'), 'base64').toString('utf8'),
  encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')),
  isEncryptionAvailable: () => true,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('ApplicationProxyStore', () => {
  it('encrypts credentials and never exposes a password in its renderer view', () => {
    const directory = createDirectory();
    const store = new ApplicationProxyStore(directory, secretStorage);

    const view = store.save({
      enabled: true,
      host: 'Proxy.Example.com',
      password: ' secret with spaces ',
      port: 8080,
      protocol: 'http',
      scope: { application: true, cli: true, conversation: false },
      username: 'alice',
    });

    expect(view).toMatchObject({
      enabled: true,
      host: 'proxy.example.com',
      passwordConfigured: true,
      port: 8080,
      username: 'alice',
    });
    expect(store.getCredentials()).toEqual({
      password: ' secret with spaces ',
      username: 'alice',
    });
    const persisted = readFileSync(path.join(directory, 'proxy', 'application-proxy.json'), 'utf8');
    expect(persisted).not.toContain(' secret with spaces ');
  });

  it('prepares a candidate without changing memory, credentials, or disk', () => {
    const directory = createDirectory();
    const store = new ApplicationProxyStore(directory, secretStorage);
    const filePath = path.join(directory, 'proxy', 'application-proxy.json');
    store.save({
      enabled: true,
      host: '127.0.0.1',
      password: 'old-secret',
      port: 7890,
      protocol: 'http',
      scope: { application: true, cli: true, conversation: false },
      username: 'alice',
    });
    const beforeView = store.getView();
    const beforeCredentials = store.getCredentials();
    const beforeFile = readFileSync(filePath, 'utf8');

    const prepared = store.prepare({
      enabled: true,
      host: 'proxy.example.com',
      password: 'new-secret',
      port: 8080,
      protocol: 'http',
      scope: { application: false, cli: true, conversation: true },
      username: 'bob',
    });

    expect(store.getView()).toEqual(beforeView);
    expect(store.getCredentials()).toEqual(beforeCredentials);
    expect(readFileSync(filePath, 'utf8')).toBe(beforeFile);
    expect(store.getView(prepared)).toMatchObject({
      host: 'proxy.example.com',
      port: 8080,
      scope: { application: false, cli: true, conversation: true },
      username: 'bob',
    });
    expect(store.getCredentials(prepared)).toEqual({
      password: 'new-secret',
      username: 'bob',
    });
  });

  it('leaves the exact current state unchanged when candidate encryption fails', () => {
    const directory = createDirectory();
    const initial = new ApplicationProxyStore(directory, secretStorage);
    initial.save({
      enabled: true,
      host: '127.0.0.1',
      password: 'old-secret',
      port: 7890,
      protocol: 'http',
      scope: { application: true, cli: true, conversation: true },
      username: 'alice',
    });
    const filePath = path.join(directory, 'proxy', 'application-proxy.json');
    const beforeFile = readFileSync(filePath, 'utf8');
    const failingStore = new ApplicationProxyStore(directory, {
      ...secretStorage,
      encryptString: () => {
        throw new Error('encryption failed');
      },
    });
    const beforeView = failingStore.getView();

    expect(() =>
      failingStore.prepare({
        enabled: true,
        host: '127.0.0.1',
        password: 'new-secret',
        port: 7891,
        protocol: 'http',
        scope: { application: true, cli: true, conversation: true },
        username: 'alice',
      }),
    ).toThrow('encryption failed');
    expect(failingStore.getView()).toEqual(beforeView);
    expect(failingStore.getCredentials()?.password).toBe('old-secret');
    expect(readFileSync(filePath, 'utf8')).toBe(beforeFile);
  });

  it('restores the exact encrypted snapshot and revision after a committed candidate', () => {
    const directory = createDirectory();
    const store = new ApplicationProxyStore(directory, secretStorage);
    const filePath = path.join(directory, 'proxy', 'application-proxy.json');
    store.save({
      enabled: true,
      host: '127.0.0.1',
      password: 'old-secret',
      port: 7890,
      protocol: 'http',
      scope: { application: true, cli: true, conversation: true },
      username: 'alice',
    });
    const snapshot = store.snapshot();
    const beforeFile = readFileSync(filePath, 'utf8');
    const beforeView = store.getView();

    store.commit(
      store.prepare({
        enabled: true,
        host: '127.0.0.1',
        password: 'new-secret',
        port: 7890,
        protocol: 'http',
        scope: { application: true, cli: true, conversation: true },
        username: 'alice',
      }),
    );
    expect(store.getCredentials()?.password).toBe('new-secret');

    expect(store.restore(snapshot)).toEqual(beforeView);
    expect(store.getCredentials()?.password).toBe('old-secret');
    expect(readFileSync(filePath, 'utf8')).toBe(beforeFile);
  });

  it('preserves a saved password when omitted and clears it with the username', () => {
    const store = new ApplicationProxyStore(createDirectory(), secretStorage);
    const base = {
      enabled: true,
      host: '127.0.0.1',
      port: 7890,
      protocol: 'http' as const,
      scope: { application: false, cli: true, conversation: false },
    };
    store.save({ ...base, password: 'one', username: 'alice' });
    store.save({ ...base, username: 'alice' });
    expect(store.getCredentials()?.password).toBe('one');
    expect(store.save({ ...base, username: '' }).passwordConfigured).toBe(false);
    expect(store.getCredentials()).toBeUndefined();
  });

  it("does not reuse another username's encrypted password when the replacement omits one", () => {
    const store = new ApplicationProxyStore(createDirectory(), secretStorage);
    const base = {
      enabled: true,
      host: '127.0.0.1',
      port: 7890,
      protocol: 'http' as const,
      scope: { application: true, cli: true, conversation: true },
    };
    store.save({ ...base, password: 'alice-secret', username: 'alice' });

    const changed = store.save({ ...base, username: 'bob' });

    expect(changed).toMatchObject({ passwordConfigured: false, username: 'bob' });
    expect(store.getCredentials()).toBeUndefined();
  });

  it('advances the revision for rapid password-only changes', () => {
    const store = new ApplicationProxyStore(createDirectory(), secretStorage);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const input = {
      enabled: true,
      host: '127.0.0.1',
      port: 7890,
      protocol: 'http' as const,
      scope: { application: true, cli: true, conversation: true },
      username: 'alice',
    };
    try {
      const first = store.save({ ...input, password: 'one' });
      const second = store.save({ ...input, password: 'two' });

      expect(second.updatedAt).toBe((first.updatedAt ?? 0) + 1);
      expect(store.getCredentials()?.password).toBe('two');
    } finally {
      now.mockRestore();
    }
  });

  it('round-trips a disabled SOCKS draft without requiring a CLI-compatible endpoint', () => {
    const directory = createDirectory();
    const store = new ApplicationProxyStore(directory, secretStorage);

    expect(
      store.save({
        enabled: false,
        host: '127.0.0.1',
        port: 1080,
        protocol: 'socks5',
        scope: { application: true, cli: true, conversation: false },
      }),
    ).toMatchObject({
      enabled: false,
      host: '127.0.0.1',
      port: 1080,
      protocol: 'socks5',
      scope: { application: true, cli: false, conversation: false },
    });

    const reloaded = new ApplicationProxyStore(directory, secretStorage).getView();
    expect(reloaded).toMatchObject({
      enabled: false,
      host: '127.0.0.1',
      port: 1080,
      protocol: 'socks5',
      scope: { application: true, cli: false, conversation: false },
    });
  });

  it('allows the disabled state to persist without an endpoint', () => {
    const directory = createDirectory();
    const store = new ApplicationProxyStore(directory, secretStorage);
    store.save({
      enabled: true,
      host: '127.0.0.1',
      port: 7890,
      protocol: 'http',
      scope: { application: false, cli: true, conversation: false },
    });

    expect(
      store.save({
        enabled: false,
        host: '',
        protocol: 'http',
        scope: { application: false, cli: true, conversation: false },
      }),
    ).toMatchObject({ enabled: false, host: '', port: undefined });
    expect(new ApplicationProxyStore(directory, secretStorage).getView()).toMatchObject({
      enabled: false,
      host: '',
      port: undefined,
    });
  });

  it('rejects a SOCKS-only port for Claude Code CLI', () => {
    const store = new ApplicationProxyStore(createDirectory(), secretStorage);
    expect(() =>
      store.save({
        enabled: true,
        host: '127.0.0.1',
        port: 1080,
        protocol: 'socks5',
        scope: { application: false, cli: true, conversation: false },
      }),
    ).toThrow('Claude Code CLI 不支持 SOCKS');
  });
});

describe('application proxy routing', () => {
  const view: ApplicationProxyView = {
    enabled: true,
    host: '2001:db8::1',
    passwordConfigured: true,
    port: 8080,
    protocol: 'http',
    scope: { application: true, cli: true, conversation: false },
    username: 'alice',
  };

  it('builds scoped Electron rules without putting credentials in the proxy URL', () => {
    expect(applicationProxyRules(view, 'application')).toEqual({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://[2001:db8::1]:8080',
    });
    expect(applicationProxyRules(view, 'conversation')).toEqual({ mode: 'direct' });
  });

  it('encodes credentials only in the child CLI environment', () => {
    expect(applicationProxyUrl(view, { password: 'p@ss word', username: 'a+b' })).toBe(
      'http://a%2Bb:p%40ss%20word@[2001:db8::1]:8080',
    );
    const environment = buildApplicationProxyEnvironment(
      view,
      { password: 'p@ss word', username: 'a+b' },
      'LOCALHOST,example.internal',
    );
    expect(environment.HTTP_PROXY).toBe('http://a%2Bb:p%40ss%20word@[2001:db8::1]:8080');
    expect(environment.NO_PROXY).toBe('127.0.0.1,localhost,::1,example.internal');
    expect(environment.CLAUDEDOCK_BUILT_IN_PROXY).toBeNull();
  });

  it('accepts simple external endpoints and rejects embedded credentials or paths', () => {
    expect(parseApplicationProxyCandidate('socks5://127.0.0.1:1080', 'system')).toEqual({
      host: '127.0.0.1',
      label: 'system',
      port: 1080,
      protocol: 'socks5',
    });
    expect(
      parseApplicationProxyCandidate('http://alice:secret@127.0.0.1:8080', 'env'),
    ).toBeUndefined();
    expect(parseApplicationProxyCandidate('http://127.0.0.1:8080/path', 'env')).toBeUndefined();
  });
});
