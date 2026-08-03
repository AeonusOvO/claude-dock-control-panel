import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationProxyRules,
  applicationProxyUrl,
  buildApplicationProxyEnvironment,
  parseApplicationProxyCandidate,
} from '../src/main/proxy/application-proxy';
import {
  ApplicationProxyStore,
  type ApplicationProxySecretStorage,
} from '../src/main/proxy/application-proxy-store';
import type { ApplicationProxyView } from '../src/shared/contracts';

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
