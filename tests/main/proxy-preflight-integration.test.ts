import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiagnosticsStore } from '../../src/main/network/diagnostics-store';
import {
  NetworkPreflightLeaseContextError,
  NetworkPreflightService,
} from '../../src/main/network/preflight-service';
import {
  type ProviderAccessRequest,
  ProviderAccessBlockedError,
  ProviderAccessContextExpiredError,
  ProviderAccessGuard,
} from '../../src/main/network/provider-access-guard';
import type {
  ConnectivityObservation,
  ProviderConnectivityProbe,
} from '../../src/main/network/provider-connectivity-probe';
import {
  ApplicationProxyCoordinator,
  ApplicationProxyPreflightLeaseError,
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

type ProxyConfiguration = Parameters<Session['setProxy']>[0];

const routeLabel = (configuration: ProxyConfiguration): string =>
  configuration.proxyRules ?? configuration.mode ?? 'unknown';

const proxyInput = (host: string): SaveApplicationProxyInput => ({
  enabled: true,
  host,
  port: 7890,
  protocol: 'http',
  scope: { application: true, cli: false, conversation: false },
  username: '',
});

const successfulObservation = (): ConnectivityObservation => ({
  paths: [
    {
      detail: 'direct',
      dnsServers: ['1.1.1.1'],
      globalIpv6Available: false,
      ipv4Available: true,
      ipv6Available: false,
      process: 'application',
      proxyConfigured: false,
      proxyKind: 'direct',
      virtualInterfaces: [],
    },
  ],
  probes: [
    {
      checkedAt: Date.now(),
      detail: 'reachable',
      id: 'app:openai-chatgpt',
      kind: 'https',
      label: 'ChatGPT',
      process: 'application',
      required: true,
      status: 'passed',
    },
  ],
});

const createDeferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const createSignal = () => {
  const deferred = createDeferred<void>();
  return {
    promise: deferred.promise,
    resolve: (): void => deferred.resolve(undefined),
  };
};

const drainMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const createComposition = (
  probe: Pick<ProviderConnectivityProbe, 'run'>,
  events: string[] = [],
) => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-proxy-preflight-integration-'));
  fixtureRoots.push(root);
  const createSession = (scope: 'application' | 'conversation') => ({
    closeAllConnections: vi.fn(async (): Promise<void> => {
      events.push(`${scope}:close`);
    }),
    setProxy: vi.fn(async (configuration: ProxyConfiguration): Promise<void> => {
      events.push(`${scope}:set:${routeLabel(configuration)}`);
    }),
  });
  const applicationSession = createSession('application');
  const conversationSession = createSession('conversation');
  const store = new ApplicationProxyStore(root, secretStorage);
  const coordinator = new ApplicationProxyCoordinator({
    applicationSession: applicationSession as never,
    assertExternalRoutingWritesAllowed: vi.fn(),
    conversationSession: conversationSession as never,
    store,
  });
  const diagnosticsStore = new NetworkDiagnosticsStore(root);
  const preflightService = new NetworkPreflightService({
    acquireNetworkLease: (scopes) => coordinator.acquirePreflightLease(scopes),
    diagnosticsStore,
    probe,
  });
  coordinator.subscribe((scope) => {
    preflightService.invalidate(`application-proxy-${scope}-transition`);
  });
  const guard = new ProviderAccessGuard(preflightService);
  return {
    applicationSession,
    conversationSession,
    coordinator,
    diagnosticsStore,
    events,
    guard,
    preflightService,
    store,
  };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('proxy and preflight integration', () => {
  it('waits for every real lease held by shared in-flight callers before saving', async () => {
    const probeStarted = createSignal();
    const probeOutcome = createDeferred<ConnectivityObservation>();
    const probeRun = vi.fn(() => {
      probeStarted.resolve();
      return probeOutcome.promise;
    });
    const harness = createComposition({ run: probeRun });
    await harness.coordinator.initialize();
    harness.events.length = 0;

    const firstFinished = createSignal();
    const secondFinished = createSignal();
    const bothOperationsStarted = createSignal();
    let operationCount = 0;
    const operation = (finished: ReturnType<typeof createSignal>, value: string) => async () => {
      operationCount += 1;
      if (operationCount === 2) bothOperationsStarted.resolve();
      await finished.promise;
      return value;
    };
    const input = { action: 'cli-launch' as const, provider: 'openai-codex' as const };

    const first = harness.preflightService.runWithLease(
      input,
      undefined,
      operation(firstFinished, 'first'),
    );
    const second = harness.preflightService.runWithLease(
      input,
      undefined,
      operation(secondFinished, 'second'),
    );
    await probeStarted.promise;
    expect(probeRun).toHaveBeenCalledOnce();
    probeOutcome.resolve(successfulObservation());
    await bothOperationsStarted.promise;

    let saveSettled = false;
    const save = harness.coordinator.save(proxyInput('shared-save.example.com')).then((view) => {
      saveSettled = true;
      return view;
    });
    firstFinished.resolve();
    await expect(first).resolves.toBe('first');
    await drainMicrotasks();

    expect(saveSettled).toBe(false);
    expect(harness.events).toEqual([]);
    expect(harness.coordinator.getView()).toMatchObject({ enabled: false, host: '' });

    secondFinished.resolve();
    await expect(second).resolves.toBe('second');
    await expect(save).resolves.toMatchObject({ host: 'shared-save.example.com' });

    expect(saveSettled).toBe(true);
    expect(harness.events).toEqual([
      'application:set:http://shared-save.example.com:7890',
      'application:close',
    ]);
    expect(probeRun).toHaveBeenCalledOnce();
  });

  it('fails multi-scope admission atomically when one real scope is unknown', async () => {
    const probeRun = vi.fn(async () => successfulObservation());
    const harness = createComposition({ run: probeRun });
    harness.conversationSession.closeAllConnections.mockRejectedValueOnce(
      new Error('conversation connections remained open'),
    );

    await expect(harness.coordinator.initialize()).rejects.toThrow(
      'conversation connections remained open',
    );
    expect(harness.coordinator.getScopeState('application')).toMatchObject({ health: 'stable' });
    expect(harness.coordinator.getScopeState('conversation')).toEqual({
      epoch: undefined,
      health: 'unknown',
    });

    const action = vi.fn();
    await expect(
      harness.guard.withAllowed(
        {
          action: 'cli-launch',
          networkScope: 'conversation',
          provider: 'openai-codex',
        },
        action,
      ),
    ).rejects.toBeInstanceOf(ApplicationProxyPreflightLeaseError);
    expect(action).not.toHaveBeenCalled();
    expect(probeRun).not.toHaveBeenCalled();

    harness.events.length = 0;
    await expect(
      harness.coordinator.save(proxyInput('atomic-save.example.com')),
    ).resolves.toMatchObject({ host: 'atomic-save.example.com' });

    expect(harness.events).toEqual([
      'application:set:http://atomic-save.example.com:7890',
      'application:close',
      'conversation:set:direct',
      'conversation:close',
    ]);
    expect(harness.coordinator.getScopeState('application').health).toBe('stable');
    expect(harness.coordinator.getScopeState('conversation').health).toBe('stable');
  });

  it('holds a cache-hit authorization lease through the actual action', async () => {
    const probeRun = vi.fn(async () => successfulObservation());
    const harness = createComposition({ run: probeRun });
    await harness.coordinator.initialize();
    await harness.coordinator.save(proxyInput('old-route.example.com'));
    const request = { action: 'cli-launch' as const, provider: 'openai-codex' as const };
    await harness.preflightService.run(request);
    expect(probeRun).toHaveBeenCalledOnce();
    harness.events.length = 0;

    const actionStarted = createSignal();
    const finishAction = createSignal();
    const routeDuringAction: string[] = [];
    const authorization = harness.guard.withAllowed(request, async () => {
      routeDuringAction.push(harness.coordinator.getView().host);
      harness.events.push('action:start');
      actionStarted.resolve();
      await finishAction.promise;
      routeDuringAction.push(harness.coordinator.getView().host);
      harness.events.push('action:finish');
      return 'request-sent';
    });
    await actionStarted.promise;

    let saveSettled = false;
    const save = harness.coordinator.save(proxyInput('new-route.example.com')).then((view) => {
      saveSettled = true;
      return view;
    });
    await drainMicrotasks();

    expect(probeRun).toHaveBeenCalledOnce();
    expect(saveSettled).toBe(false);
    expect(harness.coordinator.getView().host).toBe('old-route.example.com');
    expect(harness.events).toEqual(['action:start']);

    finishAction.resolve();
    await expect(authorization).resolves.toBe('request-sent');
    await expect(save).resolves.toMatchObject({ host: 'new-route.example.com' });

    expect(routeDuringAction).toEqual(['old-route.example.com', 'old-route.example.com']);
    expect(harness.events).toEqual([
      'action:start',
      'action:finish',
      'application:set:http://new-route.example.com:7890',
      'application:close',
    ]);
    expect(harness.coordinator.getView().host).toBe('new-route.example.com');
  });

  it('runs an exact nested provider check inside the active lease ahead of a queued save', async () => {
    const events: string[] = [];
    const probeRun = vi.fn(async () => successfulObservation());
    const harness = createComposition({ run: probeRun }, events);
    await harness.coordinator.initialize();
    await harness.coordinator.save(proxyInput('nested-old-route.example.com'));
    events.length = 0;

    const outerStarted = createSignal();
    const requestNestedCheck = createSignal();
    const authorization = harness.guard.withAllowed(
      { action: 'cli-launch', cwd: 'C:\\workspace', provider: 'openai-codex' },
      async () => {
        events.push('outer:start');
        outerStarted.resolve();
        await requestNestedCheck.promise;
        const nested = await harness.guard.withAllowed(
          { action: 'first-request', cwd: 'C:\\workspace', provider: 'openai-codex' },
          () => {
            events.push(`nested:${harness.coordinator.getView().host}`);
            return 'nested-authorized';
          },
        );
        events.push('outer:finish');
        return nested;
      },
    );
    await outerStarted.promise;

    let saveSettled = false;
    const save = harness.coordinator
      .save(proxyInput('nested-new-route.example.com'))
      .then((view) => {
        saveSettled = true;
        return view;
      });
    await drainMicrotasks();
    expect(saveSettled).toBe(false);
    expect(harness.coordinator.getView().host).toBe('nested-old-route.example.com');

    requestNestedCheck.resolve();
    await expect(authorization).resolves.toBe('nested-authorized');
    await expect(save).resolves.toMatchObject({ host: 'nested-new-route.example.com' });

    expect(probeRun).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      'outer:start',
      'nested:nested-old-route.example.com',
      'outer:finish',
      'application:set:http://nested-new-route.example.com:7890',
      'application:close',
    ]);
  });

  it('expires callback authority before a queued microtask can barge ahead of a writer', async () => {
    const events: string[] = [];
    const probeRun = vi.fn(async () => successfulObservation());
    const harness = createComposition({ run: probeRun }, events);
    await harness.coordinator.initialize();
    await harness.coordinator.save(proxyInput('microtask-old-route.example.com'));
    events.length = 0;

    const microtaskRan = createSignal();
    const escapedAction = vi.fn(() => {
      events.push(`escaped:${harness.coordinator.getView().host}`);
      return 'escaped';
    });
    let escapedCheck!: Promise<string>;
    let save!: Promise<unknown>;
    let saveSettled = false;

    const authorization = harness.guard.withAllowed(
      { action: 'cli-launch', cwd: 'C:\\workspace', provider: 'openai-codex' },
      () => {
        events.push('outer:start');
        queueMicrotask(() => {
          escapedCheck = harness.guard.withAllowed(
            { action: 'first-request', cwd: 'C:\\workspace', provider: 'openai-codex' },
            escapedAction,
          );
          void escapedCheck.catch(() => undefined);
          microtaskRan.resolve();
        });
        save = harness.coordinator
          .save(proxyInput('microtask-new-route.example.com'))
          .then((view) => {
            saveSettled = true;
            return view;
          });
        events.push('outer:return');
        return Promise.resolve('outer-authorized');
      },
    );

    await microtaskRan.promise;
    expect(saveSettled).toBe(false);
    await expect(escapedCheck).rejects.toBeInstanceOf(ProviderAccessContextExpiredError);
    await expect(authorization).resolves.toBe('outer-authorized');
    await expect(save).resolves.toMatchObject({ host: 'microtask-new-route.example.com' });

    expect(escapedAction).not.toHaveBeenCalled();
    expect(probeRun).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'outer:start',
      'outer:return',
      'application:set:http://microtask-new-route.example.com:7890',
      'application:close',
    ]);
  });

  it('rejects nested checks that change the authorized provider, project, scope, or target', async () => {
    const probeRun = vi.fn(async () => successfulObservation());
    const harness = createComposition({ run: probeRun });
    await harness.coordinator.initialize();
    const target = {
      process: 'application' as const,
      url: 'https://chatgpt.com/backend-api/conversation',
    };
    const mismatches: ProviderAccessRequest[] = [
      {
        action: 'first-request',
        cwd: 'C:\\workspace',
        networkScope: 'application',
        provider: 'anthropic-claude',
        target,
      },
      {
        action: 'first-request',
        cwd: 'C:\\other-workspace',
        networkScope: 'application',
        provider: 'openai-codex',
        target,
      },
      {
        action: 'first-request',
        cwd: 'C:\\workspace',
        networkScope: 'conversation',
        provider: 'openai-codex',
        target,
      },
      {
        action: 'first-request',
        cwd: 'C:\\workspace',
        networkScope: 'application',
        provider: 'openai-codex',
        target: {
          process: 'application',
          url: 'https://chatgpt.com/backend-api/models',
        },
      },
    ];
    const nestedAction = vi.fn();

    await expect(
      harness.guard.withAllowed(
        {
          action: 'cli-launch',
          cwd: 'C:\\workspace',
          networkScope: 'application',
          provider: 'openai-codex',
          target,
        },
        async () => {
          for (const mismatch of mismatches) {
            await expect(harness.guard.withAllowed(mismatch, nestedAction)).rejects.toBeInstanceOf(
              NetworkPreflightLeaseContextError,
            );
          }
          return 'outer-authorized';
        },
      ),
    ).resolves.toBe('outer-authorized');

    expect(nestedAction).not.toHaveBeenCalled();
    expect(probeRun).toHaveBeenCalledOnce();
  });

  it('rejects a nested check that escapes the authorized callback lifetime', async () => {
    const probeRun = vi.fn(async () => successfulObservation());
    const harness = createComposition({ run: probeRun });
    await harness.coordinator.initialize();
    const releaseEscapedCheck = createSignal();
    const escapedAction = vi.fn(() => 'escaped');
    let escapedCheck!: Promise<string>;

    await expect(
      harness.guard.withAllowed(
        { action: 'cli-launch', cwd: 'C:\\workspace', provider: 'openai-codex' },
        () => {
          escapedCheck = (async () => {
            await releaseEscapedCheck.promise;
            return harness.guard.withAllowed(
              { action: 'first-request', cwd: 'C:\\workspace', provider: 'openai-codex' },
              escapedAction,
            );
          })();
          return 'outer-authorized';
        },
      ),
    ).resolves.toBe('outer-authorized');

    releaseEscapedCheck.resolve();
    await expect(escapedCheck).rejects.toBeInstanceOf(ProviderAccessContextExpiredError);
    expect(escapedAction).not.toHaveBeenCalled();
    expect(probeRun).toHaveBeenCalledOnce();
  });

  it('releases the real lease after a probe failure so a queued save runs', async () => {
    const events: string[] = [];
    const probeStarted = createSignal();
    const probeOutcome = createDeferred<ConnectivityObservation>();
    const probeRun = vi.fn(() => {
      events.push('probe:start');
      probeStarted.resolve();
      return probeOutcome.promise;
    });
    const harness = createComposition({ run: probeRun }, events);
    await harness.coordinator.initialize();
    events.length = 0;

    const action = vi.fn();
    const authorization = harness.guard.withAllowed(
      { action: 'cli-launch', provider: 'openai-codex' },
      action,
    );
    const authorizationAssertion = expect(authorization).rejects.toBeInstanceOf(
      ProviderAccessBlockedError,
    );
    await probeStarted.promise;
    const save = harness.coordinator.save(proxyInput('after-failure.example.com'));
    await drainMicrotasks();

    expect(events).toEqual(['probe:start']);
    expect(harness.coordinator.getView()).toMatchObject({ enabled: false, host: '' });

    probeOutcome.reject(new Error('probe unavailable'));
    await authorizationAssertion;
    await expect(save).resolves.toMatchObject({ host: 'after-failure.example.com' });

    expect(action).not.toHaveBeenCalled();
    expect(events).toEqual([
      'probe:start',
      'application:set:http://after-failure.example.com:7890',
      'application:close',
    ]);
    expect(harness.diagnosticsStore.getView().entries[0]).toMatchObject({
      reasons: ['probe unavailable'],
      status: 'blocked',
    });
  });

  it('lets a queued save precede a supersession retry without barging', async () => {
    const events: string[] = [];
    const firstProbeStarted = createSignal();
    const firstProbeOutcome = createDeferred<ConnectivityObservation>();
    let probeNumber = 0;
    const probeRun = vi.fn(() => {
      probeNumber += 1;
      events.push(`probe:${probeNumber}:start`);
      if (probeNumber === 1) {
        firstProbeStarted.resolve();
        return firstProbeOutcome.promise;
      }
      return Promise.resolve(successfulObservation());
    });
    const harness = createComposition({ run: probeRun }, events);
    await harness.coordinator.initialize();
    await harness.coordinator.save(proxyInput('before-supersession.example.com'));
    events.length = 0;

    const authorization = harness.guard.withAllowed(
      { action: 'cli-launch', provider: 'openai-codex' },
      () => {
        events.push(`action:${harness.coordinator.getView().host}`);
        return 'authorized';
      },
    );
    await firstProbeStarted.promise;
    const save = harness.coordinator.save(proxyInput('after-supersession.example.com'));
    harness.preflightService.invalidate('test-supersession');
    firstProbeOutcome.resolve(successfulObservation());

    await expect(save).resolves.toMatchObject({ host: 'after-supersession.example.com' });
    await expect(authorization).resolves.toBe('authorized');

    expect(probeRun).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      'probe:1:start',
      'application:set:http://after-supersession.example.com:7890',
      'application:close',
      'probe:2:start',
      'action:after-supersession.example.com',
    ]);
    expect(harness.diagnosticsStore.getView().entries).toHaveLength(1);
    expect(harness.coordinator.getView().host).toBe('after-supersession.example.com');
  });
});
