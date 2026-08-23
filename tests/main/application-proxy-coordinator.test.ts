import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuthInfo, Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEffects } from '../../src/main/app/profile';
import { Registry } from '../../src/main/infra/registry';
import { createMainGuards } from '../../src/main/ipc/guards';
import {
  ApplicationProxyCoordinator,
  ApplicationProxyTransactionError,
} from '../../src/main/proxy/application-proxy-coordinator';
import {
  ApplicationProxyStore,
  type ApplicationProxySecretStorage,
} from '../../src/main/proxy/application-proxy-store';
import type { SaveApplicationProxyInput } from '../../src/shared/contracts';

const fixtureRoots: string[] = [];
const secretStorage: ApplicationProxySecretStorage = {
  decryptString: (value) => Buffer.from(value.toString('utf8'), 'base64').toString('utf8'),
  encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')),
  isEncryptionAvailable: () => true,
};
const isolatedEffects: RuntimeEffects = {
  allowApplicationUpdates: false,
  allowExternalRoutingWrites: false,
  allowPluginMutations: false,
  allowRealRuntimes: false,
  restoreWorkspace: false,
  singleInstanceLock: false,
  tray: false,
};

const proxyInput = (
  host: string,
  overrides: Partial<SaveApplicationProxyInput> = {},
): SaveApplicationProxyInput => ({
  enabled: true,
  host,
  port: 7890,
  protocol: 'http',
  scope: { application: true, cli: true, conversation: true },
  username: '',
  ...overrides,
});

type ProxyConfiguration = Parameters<Session['setProxy']>[0];

const createHarness = (assertExternalRoutingWritesAllowed = vi.fn()) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-proxy-coordinator-'));
  fixtureRoots.push(root);
  const applicationSession = {
    closeAllConnections: vi.fn(async (): Promise<void> => undefined),
    setProxy: vi.fn(async (_configuration: ProxyConfiguration): Promise<void> => undefined),
  };
  const conversationSession = {
    closeAllConnections: vi.fn(async (): Promise<void> => undefined),
    setProxy: vi.fn(async (_configuration: ProxyConfiguration): Promise<void> => undefined),
  };
  const store = new ApplicationProxyStore(root, secretStorage);
  const coordinator = new ApplicationProxyCoordinator({
    applicationSession: applicationSession as never,
    assertExternalRoutingWritesAllowed,
    conversationSession: conversationSession as never,
    store,
  });
  return {
    applicationSession,
    assertExternalRoutingWritesAllowed,
    conversationSession,
    coordinator,
    store,
  };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('ApplicationProxyCoordinator', () => {
  it('reconciles both uninitialized sessions and de-duplicates a stable configuration', async () => {
    const { applicationSession, conversationSession, coordinator } = createHarness();

    await coordinator.initialize();
    const application = coordinator.getScopeState('application');
    const conversation = coordinator.getScopeState('conversation');
    expect(application).toMatchObject({ health: 'stable' });
    expect(conversation).toMatchObject({ health: 'stable' });
    expect(application.epoch).toBeTruthy();
    expect(conversation.epoch).toBeTruthy();
    expect(applicationSession.setProxy).toHaveBeenCalledWith({ mode: 'system' });
    expect(conversationSession.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(applicationSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(conversationSession.closeAllConnections).toHaveBeenCalledOnce();

    await coordinator.reconcile();
    expect(coordinator.getScopeState('application').epoch).toBe(application.epoch);
    expect(coordinator.getScopeState('conversation').epoch).toBe(conversation.epoch);
    expect(applicationSession.setProxy).toHaveBeenCalledOnce();
    expect(conversationSession.setProxy).toHaveBeenCalledOnce();
  });

  it('denies direct shared saves before validation, apply, or persistence while reads and diagnostics remain usable', async () => {
    const profileGate = createMainGuards(new Registry(), isolatedEffects);
    const assertExternalRoutingWritesAllowed = vi.fn(
      profileGate.assertExternalRoutingWritesAllowed,
    );
    const { applicationSession, conversationSession, coordinator, store } = createHarness(
      assertExternalRoutingWritesAllowed,
    );
    await coordinator.initialize();
    applicationSession.setProxy.mockClear();
    applicationSession.closeAllConnections.mockClear();
    conversationSession.setProxy.mockClear();
    conversationSession.closeAllConnections.mockClear();
    const snapshot = vi.spyOn(store, 'snapshot');
    const prepare = vi.spyOn(store, 'prepare');
    const commit = vi.spyOn(store, 'commit');

    await expect(coordinator.save(proxyInput('denied-proxy.example.com'))).rejects.toThrow(
      '隔离运行配置禁止写入真实接入、路由或 MCP 配置。',
    );

    expect(assertExternalRoutingWritesAllowed).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(applicationSession.setProxy).not.toHaveBeenCalled();
    expect(applicationSession.closeAllConnections).not.toHaveBeenCalled();
    expect(conversationSession.setProxy).not.toHaveBeenCalled();
    expect(conversationSession.closeAllConnections).not.toHaveBeenCalled();
    expect(coordinator.getView()).toMatchObject({ enabled: false, host: '' });
    expect(coordinator.captureConfiguration().view).toMatchObject({ enabled: false, host: '' });

    const lease = await coordinator.acquirePreflightLease(['application', 'conversation']);
    lease.assertCurrent();
    lease.release();
    await expect(
      coordinator.runApplicationProxyTest({} as Session, (capture) => ({
        targetUrl: capture.targetUrl,
        view: capture.view,
      })),
    ).resolves.toMatchObject({
      targetUrl: 'https://github.com/',
      view: { enabled: false, host: '' },
    });
    expect(coordinator.getCliEnvironment()).toEqual({});
    expect(assertExternalRoutingWritesAllowed).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(applicationSession.setProxy).not.toHaveBeenCalled();
    expect(conversationSession.setProxy).not.toHaveBeenCalled();
  });

  it('captures stable multi-scope epochs and releases a lease idempotently', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();

    const lease = await coordinator.acquireNetworkLease([
      'conversation',
      'application',
      'conversation',
    ]);

    expect(lease.scopes).toEqual(['application', 'conversation']);
    expect(lease.epochs).toEqual({
      application: coordinator.getScopeState('application').epoch,
      conversation: coordinator.getScopeState('conversation').epoch,
    });
    lease.assertCurrent();
    lease.release();
    lease.release();
    expect(() => lease.assertCurrent()).toThrow('应用网络作用范围租约已释放');
  });

  it('does not snapshot or mutate proxy state until an active lease releases', async () => {
    const { applicationSession, coordinator, store } = createHarness();
    await coordinator.initialize();
    const snapshot = vi.spyOn(store, 'snapshot');
    snapshot.mockClear();
    applicationSession.setProxy.mockClear();
    const lease = await coordinator.acquirePreflightLease('application');

    const save = coordinator.save(
      proxyInput('leased-proxy.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(snapshot).not.toHaveBeenCalled();
    expect(applicationSession.setProxy).not.toHaveBeenCalled();

    lease.release();
    lease.release();
    await save;
    expect(snapshot).toHaveBeenCalled();
    expect(applicationSession.setProxy).toHaveBeenCalledOnce();
  });

  it('holds reconciliation behind a lease before reading committed state', async () => {
    const { coordinator, store } = createHarness();
    await coordinator.initialize();
    const snapshot = vi.spyOn(store, 'snapshot');
    snapshot.mockClear();
    const lease = await coordinator.acquirePreflightLease('conversation');

    const reconciliation = coordinator.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();

    lease.release();
    await reconciliation;
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it('does not let a later lease barge ahead of a queued save', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();
    const firstLease = await coordinator.acquirePreflightLease('application');
    const before = firstLease.epochs.application;
    const save = coordinator.save(
      proxyInput('queued-proxy.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );
    let acquired = false;
    const nextLeasePromise = coordinator.acquirePreflightLease('application').then((lease) => {
      acquired = true;
      return lease;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);

    firstLease.release();
    await save;
    const nextLease = await nextLeasePromise;
    expect(nextLease.epochs.application).toBe(coordinator.getScopeState('application').epoch);
    expect(nextLease.epochs.application).not.toBe(before);
    nextLease.release();
  });

  it('closes selected sessions and advances both epochs for a password-only change', async () => {
    const { applicationSession, conversationSession, coordinator } = createHarness();
    await coordinator.initialize();
    await coordinator.save(
      proxyInput('127.0.0.1', {
        password: 'old-secret',
        username: 'alice',
      }),
    );
    const beforeApplication = coordinator.getScopeState('application').epoch;
    const beforeConversation = coordinator.getScopeState('conversation').epoch;
    applicationSession.setProxy.mockClear();
    applicationSession.closeAllConnections.mockClear();
    conversationSession.setProxy.mockClear();
    conversationSession.closeAllConnections.mockClear();

    await coordinator.save(
      proxyInput('127.0.0.1', {
        password: 'new-secret',
        username: 'alice',
      }),
    );

    expect(applicationSession.setProxy).toHaveBeenCalledOnce();
    expect(applicationSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(conversationSession.setProxy).toHaveBeenCalledOnce();
    expect(conversationSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(coordinator.getScopeState('application').epoch).not.toBe(beforeApplication);
    expect(coordinator.getScopeState('conversation').epoch).not.toBe(beforeConversation);
  });

  it('delivers each transition against a stable listener snapshot', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();
    let unsubscribe = (): void => undefined;
    let resubscribed = false;
    const listener = vi.fn(() => {
      if (resubscribed) return;
      resubscribed = true;
      unsubscribe();
      unsubscribe = coordinator.subscribe(listener);
    });
    unsubscribe = coordinator.subscribe(listener);

    await coordinator.save(
      proxyInput('reentrant-listener.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, 'application');
    expect(listener).toHaveBeenNthCalledWith(2, 'application');
    unsubscribe();
  });

  it('marks a failed startup scope unknown and reconciles it with a fresh epoch', async () => {
    const { applicationSession, coordinator } = createHarness();
    applicationSession.closeAllConnections.mockRejectedValueOnce(
      new Error('connections remained open'),
    );

    await expect(coordinator.initialize()).rejects.toThrow('connections remained open');
    expect(coordinator.getScopeState('application')).toEqual({
      epoch: undefined,
      health: 'unknown',
    });

    await coordinator.reconcile();
    expect(coordinator.getScopeState('application')).toMatchObject({ health: 'stable' });
    expect(coordinator.getScopeState('application').epoch).toBeTruthy();
    expect(applicationSession.setProxy).toHaveBeenCalledTimes(2);
    expect(applicationSession.closeAllConnections).toHaveBeenCalledTimes(2);
  });

  it('serializes complete saves so scope applications cannot interleave', async () => {
    const { applicationSession, coordinator, store } = createHarness();
    await coordinator.initialize();
    applicationSession.setProxy.mockClear();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    applicationSession.setProxy.mockImplementationOnce(async () => firstBlocked);

    const first = coordinator.save(
      proxyInput('proxy-one.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );
    await vi.waitFor(() => expect(applicationSession.setProxy).toHaveBeenCalledOnce());
    const second = coordinator.save(
      proxyInput('proxy-two.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );
    await Promise.resolve();
    expect(applicationSession.setProxy).toHaveBeenCalledOnce();

    releaseFirst();
    await Promise.all([first, second]);
    expect(applicationSession.setProxy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ proxyRules: 'http://proxy-one.example.com:7890' }),
    );
    expect(applicationSession.setProxy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ proxyRules: 'http://proxy-two.example.com:7890' }),
    );
    expect(store.getView().host).toBe('proxy-two.example.com');
  });

  it('rolls back a failed second scope in reverse order and advances restored epochs', async () => {
    const { applicationSession, conversationSession, coordinator, store } = createHarness();
    await coordinator.initialize();
    await coordinator.save(proxyInput('old-proxy.example.com'));
    const beforeApplication = coordinator.getScopeState('application').epoch;
    const beforeConversation = coordinator.getScopeState('conversation').epoch;
    const events: string[] = [];
    applicationSession.setProxy.mockImplementation(async (rules) => {
      events.push(`application:set:${rules.proxyRules ?? rules.mode}`);
    });
    applicationSession.closeAllConnections.mockImplementation(async () => {
      events.push('application:close');
    });
    conversationSession.setProxy
      .mockImplementationOnce(async (rules) => {
        events.push(`conversation:set:${rules.proxyRules ?? rules.mode}`);
        throw new Error('conversation apply failed');
      })
      .mockImplementation(async (rules) => {
        events.push(`conversation:set:${rules.proxyRules ?? rules.mode}`);
      });
    conversationSession.closeAllConnections.mockImplementation(async () => {
      events.push('conversation:close');
    });

    await expect(coordinator.save(proxyInput('new-proxy.example.com'))).rejects.toThrow(
      'conversation apply failed',
    );

    expect(events).toEqual([
      'application:set:http://new-proxy.example.com:7890',
      'application:close',
      'conversation:set:http://new-proxy.example.com:7890',
      'conversation:set:http://old-proxy.example.com:7890',
      'conversation:close',
      'application:set:http://old-proxy.example.com:7890',
      'application:close',
    ]);
    expect(store.getView().host).toBe('old-proxy.example.com');
    expect(coordinator.getScopeState('application').health).toBe('stable');
    expect(coordinator.getScopeState('conversation').health).toBe('stable');
    expect(coordinator.getScopeState('application').epoch).not.toBe(beforeApplication);
    expect(coordinator.getScopeState('conversation').epoch).not.toBe(beforeConversation);
  });

  it('keeps a scope unknown when its reverse rollback cannot prove restoration', async () => {
    const { conversationSession, coordinator, store } = createHarness();
    await coordinator.initialize();
    await coordinator.save(proxyInput('old-proxy.example.com'));
    conversationSession.setProxy
      .mockRejectedValueOnce(new Error('conversation apply failed'))
      .mockRejectedValueOnce(new Error('conversation rollback failed'));

    const operation = coordinator.save(proxyInput('new-proxy.example.com'));
    await expect(operation).rejects.toBeInstanceOf(ApplicationProxyTransactionError);
    await expect(operation).rejects.toMatchObject({ rollbackErrors: [expect.any(Error)] });
    expect(store.getView().host).toBe('old-proxy.example.com');
    expect(coordinator.getScopeState('application').health).toBe('stable');
    expect(coordinator.getScopeState('conversation')).toEqual({
      epoch: undefined,
      health: 'unknown',
    });
  });

  it('compensates applied sessions when persistence fails after both scopes succeed', async () => {
    const { applicationSession, conversationSession, coordinator, store } = createHarness();
    await coordinator.initialize();
    await coordinator.save(proxyInput('old-proxy.example.com'));
    applicationSession.setProxy.mockClear();
    conversationSession.setProxy.mockClear();
    vi.spyOn(store, 'commit').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    await expect(coordinator.save(proxyInput('new-proxy.example.com'))).rejects.toThrow(
      'disk unavailable',
    );

    expect(applicationSession.setProxy).toHaveBeenCalledTimes(2);
    expect(conversationSession.setProxy).toHaveBeenCalledTimes(2);
    expect(applicationSession.setProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ proxyRules: 'http://old-proxy.example.com:7890' }),
    );
    expect(conversationSession.setProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ proxyRules: 'http://old-proxy.example.com:7890' }),
    );
    expect(store.getView().host).toBe('old-proxy.example.com');
    expect(coordinator.getScopeState('application').health).toBe('stable');
    expect(coordinator.getScopeState('conversation').health).toBe('stable');
  });

  it('advances only the application epoch for a CLI-only effective change', async () => {
    const { applicationSession, conversationSession, coordinator } = createHarness();
    await coordinator.initialize();
    const beforeApplication = coordinator.getScopeState('application').epoch;
    const beforeConversation = coordinator.getScopeState('conversation').epoch;
    applicationSession.setProxy.mockClear();
    conversationSession.setProxy.mockClear();

    await coordinator.save(
      proxyInput('127.0.0.1', {
        scope: { application: false, cli: true, conversation: false },
      }),
    );

    expect(coordinator.getScopeState('application').epoch).not.toBe(beforeApplication);
    expect(coordinator.getScopeState('conversation').epoch).toBe(beforeConversation);
    expect(applicationSession.setProxy).not.toHaveBeenCalled();
    expect(conversationSession.setProxy).not.toHaveBeenCalled();
  });

  it('invalidates a captured configuration only after a successful commit', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();
    const before = coordinator.captureConfiguration();

    expect(coordinator.isConfigurationCurrent(before.revision)).toBe(true);
    await coordinator.save(
      proxyInput('committed-proxy.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );

    expect(coordinator.isConfigurationCurrent(before.revision)).toBe(false);
    const after = coordinator.captureConfiguration();
    expect(after.revision).not.toBe(before.revision);
    expect(after.view.host).toBe('committed-proxy.example.com');
    expect(coordinator.isConfigurationCurrent(after.revision)).toBe(true);
  });

  it('keeps the committed configuration capture current after a failed save', async () => {
    const { applicationSession, coordinator } = createHarness();
    await coordinator.initialize();
    await coordinator.save(
      proxyInput('committed-proxy.example.com', {
        scope: { application: true, cli: false, conversation: false },
      }),
    );
    const committed = coordinator.captureConfiguration();
    applicationSession.setProxy.mockRejectedValueOnce(new Error('candidate apply failed'));

    await expect(
      coordinator.save(
        proxyInput('uncommitted-proxy.example.com', {
          scope: { application: true, cli: false, conversation: false },
        }),
      ),
    ).rejects.toThrow('candidate apply failed');

    expect(coordinator.isConfigurationCurrent(committed.revision)).toBe(true);
    expect(coordinator.captureConfiguration()).toMatchObject({
      revision: committed.revision,
      view: { host: 'committed-proxy.example.com' },
    });
  });

  it('binds proxy-test credentials to one exact Session, proxy endpoint, HTTPS origin, and request lifetime', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();
    await coordinator.save(
      proxyInput('Proxy.Example.com', {
        password: 'test-secret',
        scope: { application: false, cli: false, conversation: false },
        username: 'alice',
      }),
    );
    const testSession = {} as Session;
    const unrelatedSession = {} as Session;
    const authInfo = {
      host: 'pRoXy.Example.COM',
      isProxy: true,
      port: 7890,
    } as AuthInfo;
    let resolver:
      ((context: { authInfo: AuthInfo; requestUrl: URL; session: Session }) => unknown) | undefined;

    const revision = await coordinator.runApplicationProxyTest(testSession, (capture) => {
      resolver = capture.resolveProxyCredentials;
      expect(capture.targetUrl).toBe('https://github.com/');
      expect(capture.proxyRules).toMatchObject({
        mode: 'fixed_servers',
        proxyRules: 'http://proxy.example.com:7890',
      });
      expect(
        capture.resolveProxyCredentials({
          authInfo,
          requestUrl: new URL('https://github.com/'),
          session: testSession,
        }),
      ).toEqual({ password: 'test-secret', username: 'alice' });
      expect(
        capture.resolveProxyCredentials({
          authInfo,
          requestUrl: new URL('https://github.com/settings/profile'),
          session: testSession,
        }),
      ).toEqual({ password: 'test-secret', username: 'alice' });
      expect(
        capture.resolveProxyCredentials({
          authInfo,
          requestUrl: new URL('https://redirected.example/'),
          session: testSession,
        }),
      ).toBeUndefined();
      expect(
        capture.resolveProxyCredentials({
          authInfo,
          requestUrl: new URL('http://github.com/'),
          session: testSession,
        }),
      ).toBeUndefined();
      expect(
        capture.resolveProxyCredentials({
          authInfo,
          requestUrl: new URL('https://embedded:secret@github.com/'),
          session: testSession,
        }),
      ).toBeUndefined();
      expect(
        capture.resolveProxyCredentials({
          authInfo,
          requestUrl: new URL('https://github.com/'),
          session: unrelatedSession,
        }),
      ).toBeUndefined();
      expect(
        capture.resolveProxyCredentials({
          authInfo: { ...authInfo, host: 'other.example.com' } as AuthInfo,
          requestUrl: new URL('https://github.com/'),
          session: testSession,
        }),
      ).toBeUndefined();
      expect(
        capture.resolveProxyCredentials({
          authInfo: { ...authInfo, port: 8080 } as AuthInfo,
          requestUrl: new URL('https://github.com/'),
          session: testSession,
        }),
      ).toBeUndefined();
      expect(
        capture.resolveProxyCredentials({
          authInfo: { ...authInfo, isProxy: false } as AuthInfo,
          requestUrl: new URL('https://github.com/'),
          session: testSession,
        }),
      ).toBeUndefined();
      return capture.revision;
    });

    expect(coordinator.isConfigurationCurrent(revision)).toBe(true);
    expect(
      resolver?.({
        authInfo,
        requestUrl: new URL('https://github.com/'),
        session: testSession,
      }),
    ).toBeUndefined();
  });

  it('denies proxy-test authentication when the committed source has no credentials', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();
    await coordinator.save(proxyInput('proxy.example.com'));
    const testSession = {} as Session;

    await coordinator.runApplicationProxyTest(testSession, (capture) => {
      expect(
        capture.resolveProxyCredentials({
          authInfo: {
            host: 'proxy.example.com',
            isProxy: true,
            port: 7890,
          } as AuthInfo,
          requestUrl: new URL('https://github.com/'),
          session: testSession,
        }),
      ).toBeUndefined();
    });
  });

  it('retains old in-flight proxy-test credentials while a later save supersedes publication', async () => {
    const { coordinator } = createHarness();
    await coordinator.initialize();
    await coordinator.save(
      proxyInput('proxy.example.com', {
        password: 'old-secret',
        username: 'alice',
      }),
    );
    const testSession = {} as Session;
    const authInfo = {
      host: 'proxy.example.com',
      isProxy: true,
      port: 7890,
    } as AuthInfo;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continueTest!: () => void;
    const blocked = new Promise<void>((resolve) => {
      continueTest = resolve;
    });

    const inFlight = coordinator.runApplicationProxyTest(testSession, async (capture) => {
      const before = capture.resolveProxyCredentials({
        authInfo,
        requestUrl: new URL('https://github.com/'),
        session: testSession,
      });
      entered();
      await blocked;
      const after = capture.resolveProxyCredentials({
        authInfo,
        requestUrl: new URL('https://github.com/'),
        session: testSession,
      });
      return { after, before, revision: capture.revision };
    });
    await started;
    await coordinator.save(
      proxyInput('proxy.example.com', {
        password: 'new-secret',
        username: 'alice',
      }),
    );
    continueTest();

    const result = await inFlight;
    expect(result.before).toEqual({ password: 'old-secret', username: 'alice' });
    expect(result.after).toEqual({ password: 'old-secret', username: 'alice' });
    expect(coordinator.isConfigurationCurrent(result.revision)).toBe(false);
  });

  it('builds the CLI environment from one committed store snapshot', async () => {
    const { coordinator, store } = createHarness();
    await coordinator.initialize();
    await coordinator.save(
      proxyInput('127.0.0.1', {
        password: 'secret value',
        username: 'alice',
      }),
    );
    const snapshot = vi.spyOn(store, 'snapshot');
    const getView = vi.spyOn(store, 'getView');
    const getCredentials = vi.spyOn(store, 'getCredentials');

    const environment = coordinator.getCliEnvironment();

    expect(snapshot).toHaveBeenCalledOnce();
    const source = snapshot.mock.results[0]?.value;
    expect(source).toBeDefined();
    expect(getView).toHaveBeenCalledWith(source);
    expect(getCredentials).toHaveBeenCalledWith(source);
    expect(environment.HTTP_PROXY).toBe('http://alice:secret%20value@127.0.0.1:7890');
    expect(environment.HTTPS_PROXY).toBe(environment.HTTP_PROXY);
  });

  it('advances credentials per Electron scope and fails closed while each transition is unproven', async () => {
    const { applicationSession, conversationSession, coordinator } = createHarness();
    await coordinator.initialize();
    await coordinator.save(
      proxyInput('127.0.0.1', {
        password: 'old-secret',
        username: 'alice',
      }),
    );
    let releaseApplication!: () => void;
    let releaseConversation!: () => void;
    const applicationBlocked = new Promise<void>((resolve) => {
      releaseApplication = resolve;
    });
    const conversationBlocked = new Promise<void>((resolve) => {
      releaseConversation = resolve;
    });
    applicationSession.setProxy.mockClear();
    conversationSession.setProxy.mockClear();
    applicationSession.setProxy.mockImplementationOnce(async () => applicationBlocked);
    conversationSession.setProxy.mockImplementationOnce(async () => conversationBlocked);

    const save = coordinator.save(
      proxyInput('127.0.0.1', {
        password: 'new-secret',
        username: 'alice',
      }),
    );
    await vi.waitFor(() => expect(applicationSession.setProxy).toHaveBeenCalledOnce());
    expect(
      coordinator.credentialsForProxy(applicationSession as never, '127.0.0.1', 7890),
    ).toBeUndefined();
    expect(
      coordinator.credentialsForProxy(conversationSession as never, '127.0.0.1', 7890),
    ).toEqual({ password: 'old-secret', username: 'alice' });

    releaseApplication();
    await vi.waitFor(() => expect(conversationSession.setProxy).toHaveBeenCalledOnce());
    expect(coordinator.credentialsForProxy(applicationSession as never, '127.0.0.1', 7890)).toEqual(
      { password: 'new-secret', username: 'alice' },
    );
    expect(
      coordinator.credentialsForProxy(conversationSession as never, '127.0.0.1', 7890),
    ).toBeUndefined();

    releaseConversation();
    await save;
    expect(
      coordinator.credentialsForProxy(conversationSession as never, '127.0.0.1', 7890),
    ).toEqual({ password: 'new-secret', username: 'alice' });
    expect(coordinator.credentialsForProxy({} as never, '127.0.0.1', 7890)).toBeUndefined();
    expect(
      coordinator.credentialsForProxy(applicationSession as never, 'other.example.com', 7890),
    ).toBeUndefined();
    expect(
      coordinator.credentialsForProxy(applicationSession as never, '127.0.0.1', 8080),
    ).toBeUndefined();
  });
});
