/* eslint-disable max-lines -- This integration specification exercises one shared preflight concurrency harness and its complete race matrix. */
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkPreflightResult, NetworkPreflightScope } from '../../src/shared/contracts';
import {
  type ConnectivityObservation,
  ProviderConnectivityProbe,
} from '../../src/main/network/provider-connectivity-probe';
import { NetworkDiagnosticsStore } from '../../src/main/network/diagnostics-store';
import {
  type NetworkPreflightLease,
  NetworkPreflightService,
  NetworkPreflightSupersededError,
} from '../../src/main/network/preflight-service';
import { ProviderAccessGuard } from '../../src/main/network/provider-access-guard';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preflight-service-'));
  roots.push(root);
  return root;
};

const createNetworkLeaseHarness = (
  epochFor: (scope: NetworkPreflightScope) => string = (scope) => `${scope}-epoch`,
) => {
  const leases: NetworkPreflightLease[] = [];
  const acquireNetworkLease = vi.fn(
    async (
      scopes: NetworkPreflightScope | readonly NetworkPreflightScope[],
    ): Promise<NetworkPreflightLease> => {
      const requested = typeof scopes === 'string' ? [scopes] : scopes;
      const normalized = Object.freeze(
        (['application', 'conversation'] as const).filter((scope) => requested.includes(scope)),
      );
      let released = false;
      const epochs = Object.freeze(
        Object.fromEntries(normalized.map((scope) => [scope, epochFor(scope)])),
      );
      const lease: NetworkPreflightLease = {
        assertCurrent: () => {
          if (released) throw new Error('lease released');
          if (normalized.some((scope) => epochFor(scope) !== epochs[scope])) {
            throw new Error('lease superseded');
          }
        },
        epochs,
        release: vi.fn(() => {
          released = true;
        }),
        scopes: normalized,
      };
      leases.push(lease);
      return lease;
    },
  );
  return { acquireNetworkLease, leases };
};

const networkLeaseOptions = () => {
  const { acquireNetworkLease } = createNetworkLeaseHarness();
  return { acquireNetworkLease };
};

const successfulObservation = (): ConnectivityObservation => ({
  paths: [
    {
      detail: 'direct',
      dnsServers: ['1.1.1.1'],
      globalIpv6Available: false,
      ipv4Available: true,
      ipv6Available: false,
      networkScope: 'application',
      process: 'application',
      proxyConfigured: false,
      proxyKind: 'direct',
      target: 'https://chatgpt.com/',
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

const failedRequiredObservation = (detail: string): ConnectivityObservation => ({
  ...successfulObservation(),
  probes: [
    {
      checkedAt: Date.now(),
      detail,
      id: 'app:openai-chatgpt',
      kind: 'https',
      label: 'ChatGPT',
      process: 'application',
      required: true,
      status: 'failed',
    },
  ],
});

describe('NetworkPreflightService', () => {
  it('deduplicates concurrent checks and reuses a fresh cache', async () => {
    const root = createRoot();
    let release: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          release = resolve;
        }),
    );
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };

    const first = service.run(input);
    const second = service.run(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release?.(successfulObservation());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);

    await service.run(input);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('projects cached advisory rows as cached without mutating live evidence', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const environmentProbe = {
      run: vi.fn(async () => ({
        checkedAt: 100,
        checks: [
          {
            authority: 'advisory-only' as const,
            checkedAt: 101,
            confidence: 'medium' as const,
            detail: 'live DNS evidence',
            freshness: 'live' as const,
            id: 'dns-authoritative' as const,
            label: '权威 DNS 观察',
            networkScope: 'application' as const,
            process: 'network-diagnostics' as const,
            source: 'dnscheck.tools',
            status: 'passed' as const,
            target: '*.test.dnscheck.tools TXT',
            transport: 'system-dns' as const,
          },
        ],
        dnsDetail: 'live DNS evidence',
        dnsStatus: 'consistent' as const,
        evidenceStatus: 'complete' as const,
        issues: [],
        localLanguage: 'zh-CN',
        localTimezone: 'Asia/Shanghai',
        publicAddressObservations: [
          {
            addressFamily: 'ipv4' as const,
            addressPrefix: '203.0.113.0/24',
            checkedAt: 102,
            confidence: 'medium' as const,
            detail: 'live endpoint-scoped observation',
            endpoint: 'https://api.ipquery.io/?format=json',
            freshness: 'live' as const,
            networkScope: 'application' as const,
            observationProvider: 'IPQuery',
            process: 'network-diagnostics' as const,
            sourceAgreement: 'single-source' as const,
            state: 'complete' as const,
            statement: 'destination-scoped advisory evidence',
            transport: 'curl-cli' as const,
          },
        ],
        riskLevel: 'low' as const,
        summary: 'live advisory evidence',
      })),
    };
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      environmentProbe,
      probe: { run },
      shouldAssessEnvironment: () => true,
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };

    const live = await service.run(input);
    const cached = await service.run(input);

    expect(run).toHaveBeenCalledOnce();
    expect(environmentProbe.run).toHaveBeenCalledOnce();
    expect(live.advisoryEvidence.environment?.checks?.[0]?.freshness).toBe('live');
    expect(live.advisoryEvidence.environment?.publicAddressObservations[0]?.freshness).toBe('live');
    expect(cached).not.toBe(live);
    expect(cached.advisoryEvidence.environment?.checks?.[0]).toMatchObject({
      checkedAt: 101,
      freshness: 'cached',
    });
    expect(cached.advisoryEvidence.environment?.publicAddressObservations[0]).toMatchObject({
      checkedAt: 102,
      freshness: 'cached',
    });
    expect(cached.environment).toBe(cached.advisoryEvidence.environment);
  });

  it('transfers the first lease to the shared run without a second queued acquisition', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    let blockLaterAcquisitions = false;
    const acquireNetworkLease = vi.fn(
      (scopes: NetworkPreflightScope | readonly NetworkPreflightScope[]) => {
        if (blockLaterAcquisitions) return new Promise<NetworkPreflightLease>(() => undefined);
        return leaseHarness.acquireNetworkLease(scopes);
      },
    );
    let finishProbe!: (value: ConnectivityObservation) => void;
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const service = new NetworkPreflightService({
      acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });

    const operation = service.run({ action: 'background', provider: 'openai-codex' });
    blockLaterAcquisitions = true;
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(acquireNetworkLease).toHaveBeenCalledOnce();

    finishProbe(successfulObservation());
    await expect(operation).resolves.toMatchObject({
      status: expect.not.stringMatching('blocked'),
    });
  });

  it.each([
    ['the first owner', 0],
    ['a coalesced non-owner', 1],
  ] as const)(
    'cancels %s without aborting a surviving shared waiter',
    async (_label, cancelIndex) => {
      const root = createRoot();
      const leaseHarness = createNetworkLeaseHarness();
      const controllers = [new AbortController(), new AbortController()] as const;
      const abortErrors = [new Error('owner cancelled'), new Error('non-owner cancelled')] as const;
      let finishProbe!: (value: ConnectivityObservation) => void;
      let probeSignal: AbortSignal | undefined;
      const run = vi.fn((...args: unknown[]) => {
        probeSignal = args[5] as AbortSignal;
        return new Promise<ConnectivityObservation>((resolve) => {
          finishProbe = resolve;
        });
      });
      const service = new NetworkPreflightService({
        acquireNetworkLease: leaseHarness.acquireNetworkLease,
        diagnosticsStore: new NetworkDiagnosticsStore(root),
        probe: { run },
      });
      const input = { action: 'background' as const, provider: 'openai-codex' as const };
      const operations = controllers.map((controller) =>
        service.run(input, undefined, controller.signal),
      );
      const outcomes = operations.map((operation) =>
        operation.then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ error, ok: false as const }),
        ),
      );

      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      controllers[cancelIndex].abort(abortErrors[cancelIndex]);
      await expect(outcomes[cancelIndex]).resolves.toEqual({
        error: abortErrors[cancelIndex],
        ok: false,
      });
      expect(probeSignal?.aborted).toBe(false);
      expect(leaseHarness.leases).toHaveLength(2);
      expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();
      expect(leaseHarness.leases[1]?.release).toHaveBeenCalledOnce();

      finishProbe(successfulObservation());
      await expect(outcomes[1 - cancelIndex]).resolves.toMatchObject({ ok: true });
      expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
    },
  );

  it('aborts the shared run at the last cancelled waiter but retains its lease through cleanup', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanupStarted = vi.fn();
    let probeSignal: AbortSignal | undefined;
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: {
        run: vi.fn((...args: unknown[]) => {
          const signal = args[5] as AbortSignal;
          probeSignal = signal;
          return new Promise<ConnectivityObservation>((_resolve, reject) => {
            const onAbort = (): void => {
              cleanupStarted();
              void cleanup.then(() => reject(signal.reason));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          });
        }),
      },
    });
    const controller = new AbortController();
    const abortError = new Error('last waiter cancelled');
    const operation = service.run(
      { action: 'background', provider: 'openai-codex' },
      undefined,
      controller.signal,
    );
    let settled = false;
    const outcome = operation
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ error, ok: false as const }),
      )
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(probeSignal).toBeInstanceOf(AbortSignal));
    controller.abort(abortError);
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(probeSignal?.aborted).toBe(true);
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();

    finishCleanup();
    await expect(outcome).resolves.toEqual({ error: abortError, ok: false });
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('starts a fresh isolated run after every waiter cancels without orphan rejection', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    const signals: AbortSignal[] = [];
    let finishOldCleanup!: () => void;
    let finishFresh!: (value: ConnectivityObservation) => void;
    const oldCleanup = new Promise<void>((resolve) => {
      finishOldCleanup = resolve;
    });
    const run = vi.fn((...args: unknown[]): Promise<ConnectivityObservation> => {
      const signal = args[5] as AbortSignal;
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            void oldCleanup.then(() => reject(new Error('late orphan cleanup failure')));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return new Promise((resolve) => {
        finishFresh = resolve;
      });
    });
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };
    const controller = new AbortController();
    const abortError = new Error('cancel all waiters');
    const stale = service.run(input, undefined, controller.signal);
    const staleOutcome = stale.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    controller.abort(abortError);
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    const fresh = service.run(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(signals[1]?.aborted).toBe(false);

    finishFresh(successfulObservation());
    await expect(fresh).resolves.toMatchObject({ status: expect.not.stringMatching('blocked') });
    finishOldCleanup();
    await expect(staleOutcome).resolves.toEqual({ error: abortError, ok: false });
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('rejects a pre-aborted caller without acquiring a lease or starting a probe', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    const run = vi.fn(async () => successfulObservation());
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const controller = new AbortController();
    const abortError = new Error('already cancelled');
    controller.abort(abortError);

    await expect(
      service.run({ action: 'background', provider: 'openai-codex' }, undefined, controller.signal),
    ).rejects.toBe(abortError);
    expect(leaseHarness.acquireNetworkLease).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('holds shared authority until a cancelled authorized operation unwinds', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run: vi.fn(async () => successfulObservation()) },
    });
    const controller = new AbortController();
    const abortError = new Error('operation cancelled');
    let finishOperation!: () => void;
    const operationStarted = vi.fn();
    const guarded = service.runWithLease(
      { action: 'cli-launch', provider: 'openai-codex' },
      undefined,
      () => {
        operationStarted();
        return new Promise<void>((resolve) => {
          finishOperation = resolve;
        });
      },
      controller.signal,
    );
    const outcome = guarded.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    await vi.waitFor(() => expect(operationStarted).toHaveBeenCalledOnce());
    controller.abort(abortError);
    await Promise.resolve();
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();

    finishOperation();
    await expect(outcome).resolves.toEqual({ error: abortError, ok: false });
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('holds the caller lease until the authorized operation finishes', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run: vi.fn(async () => successfulObservation()) },
    });
    let finishOperation!: (value: string) => void;
    const operationStarted = vi.fn();

    const result = service.runWithLease(
      { action: 'cli-launch', provider: 'openai-codex' },
      undefined,
      () => {
        operationStarted();
        return new Promise<string>((resolve) => {
          finishOperation = resolve;
        });
      },
    );

    await vi.waitFor(() => expect(operationStarted).toHaveBeenCalledOnce());
    expect(leaseHarness.leases).toHaveLength(1);
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();

    finishOperation('started');
    await expect(result).resolves.toBe('started');
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('retains one lease per shared in-flight caller until each operation finishes', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    let finishProbe!: (value: ConnectivityObservation) => void;
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: {
        run: vi.fn(
          () =>
            new Promise<ConnectivityObservation>((resolve) => {
              finishProbe = resolve;
            }),
        ),
      },
    });
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstOperation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const secondOperation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        }),
    );
    const input = { action: 'cli-launch' as const, provider: 'openai-codex' as const };

    const first = service.runWithLease(input, undefined, firstOperation);
    const second = service.runWithLease(input, undefined, secondOperation);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    finishProbe(successfulObservation());
    await vi.waitFor(() => {
      expect(firstOperation).toHaveBeenCalledOnce();
      expect(secondOperation).toHaveBeenCalledOnce();
    });

    expect(leaseHarness.leases).toHaveLength(2);
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();
    expect(leaseHarness.leases[1]?.release).toHaveBeenCalledOnce();

    finishFirst();
    await first;
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();

    finishSecond();
    await second;
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('composes separately captured exact targets by structural identity', async () => {
    const root = createRoot();
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run: vi.fn(async () => successfulObservation()) },
    });
    const input = { action: 'cli-launch' as const, provider: 'anthropic-claude' as const };
    const url = 'https://gateway.example.test/v1/messages';

    await expect(
      service.runWithLease(input, { process: 'claude-cli', url }, (_result, leaseContext) =>
        service.runWithExistingLease(
          input,
          { process: 'claude-cli', url },
          leaseContext,
          () => 'nested-complete',
        ),
      ),
    ).resolves.toBe('nested-complete');
  });

  it('retains a borrowed outer lease while an external coalesced operation still uses it', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    let finishProbe!: (value: ConnectivityObservation) => void;
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: {
        run: vi.fn(
          () =>
            new Promise<ConnectivityObservation>((resolve) => {
              finishProbe = resolve;
            }),
        ),
      },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };
    let finishExternal!: () => void;
    const externalOperation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishExternal = resolve;
        }),
    );
    let outerSettled = false;
    const outer = service
      .runWithCurrentRouteLease(input, undefined, (_identity, leaseContext) =>
        service.runWithExistingLease(input, undefined, leaseContext, () => 'nested-complete'),
      )
      .finally(() => {
        outerSettled = true;
      });
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    const external = service.runWithLease(input, undefined, externalOperation);
    await vi.waitFor(() => expect(leaseHarness.leases).toHaveLength(2));

    finishProbe(successfulObservation());
    await vi.waitFor(() => expect(externalOperation).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(outerSettled).toBe(false);
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();
    expect(leaseHarness.leases[1]?.release).toHaveBeenCalledOnce();

    finishExternal();
    await expect(external).resolves.toBeUndefined();
    await expect(outer).resolves.toBe('nested-complete');
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('rejects a current-route bypass invalidated while its operation is pending', async () => {
    const root = createRoot();
    const leaseHarness = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run: vi.fn(async () => successfulObservation()) },
    });
    let finishOperation: ((value: string) => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishOperation = resolve;
        }),
    );
    const routeOperation = service.runWithCurrentRouteLease(
      { action: 'first-request', provider: 'openai-api' },
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      operation,
    );

    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    service.invalidate('route-changed');
    finishOperation?.('request-finished');

    await expect(routeOperation).rejects.toBeInstanceOf(NetworkPreflightSupersededError);
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('owns canonical launch identity and acquires every targetless conversation dependency', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const onResult = vi.fn();
    const leaseHarness = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      onResult,
      probe: { run },
    });
    const canonicalCwd = path.resolve('relative-project');

    const result = await service.run({
      action: 'first-request',
      cwd: 'relative-project',
      networkScope: 'conversation',
      provider: 'openai-codex',
    });

    expect(leaseHarness.acquireNetworkLease).toHaveBeenCalledWith(['application', 'conversation']);
    expect(run).toHaveBeenCalledWith(
      'openai-codex',
      'first-request',
      homedir(),
      'conversation',
      undefined,
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      action: 'first-request',
      canonicalCwd,
      configurationRevision: expect.any(String),
      generation: 0,
      mainRunId: 1,
      networkScope: 'conversation',
    });
    expect(result.configurationRevision).not.toContain('application-epoch');
    expect(result.configurationRevision).not.toContain('conversation-epoch');
    expect(onResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: result.action,
        canonicalCwd: result.canonicalCwd,
        configurationRevision: result.configurationRevision,
        generation: result.generation,
        mainRunId: result.mainRunId,
        advisoryEvidence: expect.objectContaining({
          paths: [],
          riskLevel: 'unknown',
          riskScore: 0,
        }),
        networkScope: result.networkScope,
        paths: [],
        probes: [],
        providerConnectivity: expect.objectContaining({ status: 'testing' }),
        schemaVersion: 2,
        status: 'testing',
      }),
    );
    expect(onResult).toHaveBeenNthCalledWith(2, result);
    expect(service.getHistory().entries[0]).not.toHaveProperty('canonicalCwd');
  });

  it('separates cache entries by project, scope, and stable proxy epochs', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    let applicationEpoch = 'application-1';
    const leaseHarness = createNetworkLeaseHarness((scope) =>
      scope === 'application' ? applicationEpoch : 'conversation-1',
    );
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const base = {
      action: 'background' as const,
      cwd: 'project-a',
      provider: 'openai-codex' as const,
    };

    await service.run(base);
    await service.run(base);
    applicationEpoch = 'application-2';
    await service.run(base);
    await service.run({ ...base, networkScope: 'conversation' });
    await service.run({ ...base, cwd: 'project-b' });

    expect(run).toHaveBeenCalledTimes(4);
  });

  it('bounds inactive cache identities without evicting an active authorization', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    vi.spyOn(diagnosticsStore, 'append').mockImplementation(() => undefined);
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore,
      probe: { run },
    });
    let releaseHeld!: () => void;
    const heldStarted = vi.fn();
    const heldInput = {
      action: 'background' as const,
      cwd: 'held-project',
      provider: 'openai-codex' as const,
    };
    const held = service.runWithLease(heldInput, undefined, async () => {
      heldStarted();
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    });
    await vi.waitFor(() => expect(heldStarted).toHaveBeenCalledOnce());

    try {
      for (let index = 0; index < 256; index += 1) {
        await service.run({
          action: 'background',
          cwd: `project-${index}`,
          provider: 'openai-codex',
        });
      }
      expect(run).toHaveBeenCalledTimes(257);

      await service.run(heldInput);
      expect(run).toHaveBeenCalledTimes(257);

      await service.run({
        action: 'background',
        cwd: 'project-0',
        provider: 'openai-codex',
      });
      expect(run).toHaveBeenCalledTimes(258);
    } finally {
      releaseHeld();
      await held;
    }
  });

  it('separates exact application targets in private cache identity', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = {
      action: 'first-request' as const,
      networkScope: 'conversation' as const,
      provider: 'openai-api' as const,
    };
    const firstTarget = {
      process: 'application' as const,
      url: 'https://api.openai.com/v1/chat/completions',
    };
    const secondTarget = {
      process: 'application' as const,
      url: 'https://api.openai.com/custom/chat/completions',
    };

    await service.run(input, firstTarget);
    await service.run(input, firstTarget);
    await service.run(input, secondTarget);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      1,
      'openai-api',
      'first-request',
      homedir(),
      'conversation',
      firstTarget,
      expect.any(AbortSignal),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'openai-api',
      'first-request',
      homedir(),
      'conversation',
      secondTarget,
      expect.any(AbortSignal),
    );
  });

  it('does not let an untargeted official Claude cache authorize a custom gateway', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = {
      action: 'cli-launch' as const,
      provider: 'anthropic-claude' as const,
    };
    const firstGateway = {
      process: 'claude-cli' as const,
      url: 'https://gateway.example.test/v1/messages',
    };
    const secondGateway = {
      process: 'claude-cli' as const,
      url: 'https://other.example.test/v1/messages',
    };

    await service.run(input);
    await service.run(input);
    await service.run(input, firstGateway);
    await service.run(input, firstGateway);
    await service.run(input, secondGateway);

    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(
      1,
      'anthropic-claude',
      'cli-launch',
      homedir(),
      'application',
      undefined,
      expect.any(AbortSignal),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'anthropic-claude',
      'cli-launch',
      homedir(),
      'application',
      firstGateway,
      expect.any(AbortSignal),
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      'anthropic-claude',
      'cli-launch',
      homedir(),
      'application',
      secondGateway,
      expect.any(AbortSignal),
    );
  });

  it('freezes and canonicalizes an exact target before lease admission', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const leaseHarness = createNetworkLeaseHarness();
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const acquireNetworkLease = vi.fn(
      async (scopes: NetworkPreflightScope | readonly NetworkPreflightScope[]) => {
        await admission;
        return leaseHarness.acquireNetworkLease(scopes);
      },
    );
    const service = new NetworkPreflightService({
      acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const target = {
      process: 'application' as const,
      url: 'https://api.openai.com:443/v1/chat/completions',
    };

    const operation = service.run(
      {
        action: 'first-request',
        networkScope: 'conversation',
        provider: 'openai-api',
      },
      target,
    );
    target.url = 'https://example.test/replaced';
    releaseAdmission();
    await operation;

    expect(acquireNetworkLease).toHaveBeenCalledWith(['conversation']);
    const forwardedTarget = (run.mock.calls as unknown as readonly (readonly unknown[])[])[0]?.[4];
    expect(forwardedTarget).toEqual({
      process: 'application',
      url: 'https://api.openai.com/v1/chat/completions',
    });
    expect(forwardedTarget).not.toBe(target);
    expect(Object.isFrozen(forwardedTarget)).toBe(true);
  });

  it('rejects a result when its leased proxy epoch changes during the probe', async () => {
    const root = createRoot();
    let release: ((value: ConnectivityObservation) => void) | undefined;
    let applicationEpoch = 'application-1';
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const leaseHarness = createNetworkLeaseHarness(() => applicationEpoch);
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore,
      probe: {
        run: () =>
          new Promise<ConnectivityObservation>((resolve) => {
            release = resolve;
          }),
      },
    });

    const operation = service.run({
      action: 'first-request',
      provider: 'openai-codex',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    applicationEpoch = 'application-2';
    release?.(successfulObservation());

    await expect(operation).rejects.toBeInstanceOf(NetworkPreflightSupersededError);
    expect(diagnosticsStore.getView().entries).toHaveLength(0);
  });

  it('starts a forced check immediately and aborts older same-key work', async () => {
    const root = createRoot();
    const signals: AbortSignal[] = [];
    let finishFresh: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi.fn((...args: unknown[]): Promise<ConnectivityObservation> => {
      const signal = args[5];
      if (!(signal instanceof AbortSignal)) {
        return Promise.reject(new Error('authoritative signal missing'));
      }
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise((_resolve, reject) => {
          const rejectAbort = (): void => reject(signal.reason);
          if (signal.aborted) {
            rejectAbort();
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true });
          }
        });
      }
      return new Promise((resolve) => {
        finishFresh = resolve;
      });
    });
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const leaseHarness = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore,
      probe: { run },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };

    const stale = service.run(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const staleAssertion = expect(stale).rejects.toMatchObject({
      currentRunId: 2,
      startedRunId: 1,
    });
    const fresh = service.run({ ...input, force: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(fresh).not.toBe(stale);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await staleAssertion;
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
    expect(leaseHarness.leases[1]?.release).not.toHaveBeenCalled();

    finishFresh?.(successfulObservation());
    await expect(fresh).resolves.toMatchObject({ status: expect.not.stringMatching('blocked') });
    expect(leaseHarness.leases[1]?.release).toHaveBeenCalledOnce();
    expect(diagnosticsStore.getView().entries).toHaveLength(1);
  });

  it('keeps an allowed verdict when diagnostic persistence fails', async () => {
    const root = createRoot();
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    vi.spyOn(diagnosticsStore, 'append').mockImplementation(() => {
      throw new Error('history unavailable');
    });
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore,
      probe: { run: vi.fn(async () => successfulObservation()) },
    });

    const result = await service.run({
      action: 'cli-launch',
      provider: 'openai-codex',
    });

    expect(result.status).not.toBe('blocked');
    expect(result.featureAccess.find(({ action }) => action === 'cli-launch')?.allowed).toBe(true);
  });

  it('keeps an allowed verdict when testing and final notifications fail', async () => {
    const root = createRoot();
    const onResult = vi.fn(() => {
      throw new Error('renderer unavailable');
    });
    const run = vi.fn(async () => successfulObservation());
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      onResult,
      probe: { run },
    });

    const result = await service.run({
      action: 'cli-launch',
      provider: 'openai-codex',
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(result.status).not.toBe('blocked');
    expect(result.featureAccess.find(({ action }) => action === 'cli-launch')?.allowed).toBe(true);
  });

  it('keeps provider access allowed when advisory environment collection fails', async () => {
    const root = createRoot();
    const environmentProbe = {
      run: vi.fn((): never => {
        throw new Error('environment intelligence unavailable');
      }),
    };
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      environmentProbe,
      probe: { run: vi.fn(async () => successfulObservation()) },
      shouldAssessEnvironment: () => true,
    });

    const result = await service.run({
      action: 'cli-launch',
      provider: 'openai-codex',
    });

    expect(environmentProbe.run).toHaveBeenCalledOnce();
    expect(result.providerConnectivity).toMatchObject({
      featureAccess: [{ action: 'cli-launch', allowed: true }],
      reasons: [],
      status: 'allowed',
    });
    expect(result.status).toBe('allowed_with_notice');
    expect(result.advisoryEvidence).toMatchObject({
      environment: {
        evidenceStatus: 'unavailable',
        issues: [expect.objectContaining({ kind: 'evidence-incomplete' })],
        riskLevel: 'unknown',
      },
      riskLevel: 'unknown',
    });
  });

  it('preserves advisory evidence that completes within the collection budget', async () => {
    const root = createRoot();
    const environmentAssessment: NonNullable<ConnectivityObservation['environment']> = {
      checkedAt: Date.now(),
      checks: [],
      dnsDetail: '辅助 DNS 证据已完成。',
      dnsStatus: 'consistent',
      evidenceStatus: 'complete',
      issues: [],
      localLanguage: 'zh-CN',
      localTimezone: 'Asia/Shanghai',
      publicAddressObservations: [],
      riskLevel: 'low',
      summary: '环境辅助证据已完成。',
    };
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      environmentProbe: { run: vi.fn(async () => environmentAssessment) },
      environmentTimeoutMs: 50,
      probe: { run: vi.fn(async () => successfulObservation()) },
      shouldAssessEnvironment: () => true,
    });

    const result = await service.run({
      action: 'cli-launch',
      provider: 'openai-codex',
    });

    expect(result.advisoryEvidence.environment).toEqual(environmentAssessment);
    expect(result.providerConnectivity.featureAccess).toEqual([
      { action: 'cli-launch', allowed: true },
    ]);
  });

  it('bounds pending advisory collection without blocking provider authorization indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const root = createRoot();
      let environmentSignal: AbortSignal | undefined;
      let providerSettled = false;
      const environmentProbe = {
        run: vi.fn((signal?: AbortSignal): Promise<never> => {
          environmentSignal = signal;
          return new Promise(() => undefined);
        }),
      };
      const providerProbe = {
        run: vi.fn(() =>
          Promise.resolve(successfulObservation()).finally(() => {
            providerSettled = true;
          }),
        ),
      };
      const service = new NetworkPreflightService({
        ...networkLeaseOptions(),
        diagnosticsStore: new NetworkDiagnosticsStore(root),
        environmentProbe,
        environmentTimeoutMs: 50,
        probe: providerProbe,
        shouldAssessEnvironment: () => true,
      });
      let preflightSettled = false;
      const pending = service
        .run({
          action: 'cli-launch',
          provider: 'openai-codex',
        })
        .finally(() => {
          preflightSettled = true;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(providerProbe.run).toHaveBeenCalledOnce();
      expect(providerSettled).toBe(true);
      expect(environmentProbe.run).toHaveBeenCalledOnce();
      expect(environmentSignal?.aborted).toBe(false);
      expect(preflightSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(49);
      expect(environmentSignal?.aborted).toBe(false);
      expect(preflightSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(environmentSignal?.aborted).toBe(true);
      expect(result.providerConnectivity.featureAccess).toEqual([
        { action: 'cli-launch', allowed: true },
      ]);
      expect(result.advisoryEvidence.environment).toMatchObject({
        evidenceStatus: 'unavailable',
        issues: [
          expect.objectContaining({
            detail: '网络环境建议证据收集超时。',
            kind: 'evidence-incomplete',
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates cancellation while advisory environment collection is pending', async () => {
    const root = createRoot();
    let environmentSignal: AbortSignal | undefined;
    const environmentProbe = {
      run: vi.fn(
        (signal?: AbortSignal): Promise<never> =>
          new Promise((_resolve, reject) => {
            environmentSignal = signal;
            const rejectAbort = (): void => reject(signal?.reason);
            if (signal?.aborted) rejectAbort();
            else signal?.addEventListener('abort', rejectAbort, { once: true });
          }),
      ),
    };
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      environmentProbe,
      probe: { run: vi.fn(async () => successfulObservation()) },
      shouldAssessEnvironment: () => true,
    });
    const controller = new AbortController();
    const abortError = new Error('environment check cancelled');
    const pending = service.run(
      { action: 'cli-launch', provider: 'openai-codex' },
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(environmentSignal).toBeInstanceOf(AbortSignal));
    controller.abort(abortError);

    await expect(pending).rejects.toBe(abortError);
    expect(environmentSignal?.aborted).toBe(true);
    expect(service.getHistory().entries).toEqual([]);
  });

  it('preserves a real probe failure when failure reporting also fails', async () => {
    const root = createRoot();
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    vi.spyOn(diagnosticsStore, 'append').mockImplementation(() => {
      throw new Error('history unavailable');
    });
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore,
      onResult: () => {
        throw new Error('renderer unavailable');
      },
      probe: {
        run: vi.fn(async () => {
          throw new Error('probe unavailable');
        }),
      },
    });

    const result = await service.run({
      action: 'cli-launch',
      provider: 'openai-codex',
    });

    expect(result.providerConnectivity).toMatchObject({
      featureAccess: [expect.objectContaining({ action: 'cli-launch', allowed: false })],
      reasons: ['probe unavailable'],
      signals: [expect.objectContaining({ id: 'preflight-internal-failure' })],
      status: 'blocked',
    });
    expect(result.advisoryEvidence).toMatchObject({
      paths: [],
      reasons: [],
      riskLevel: 'unknown',
      riskScore: 0,
      signals: [],
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons).toContain('probe unavailable');
  });

  it('revokes an older cached allow when a forced authoritative run fails internally', async () => {
    const root = createRoot();
    const run = vi
      .fn()
      .mockResolvedValueOnce(successfulObservation())
      .mockRejectedValueOnce(new Error('forced probe unavailable'))
      .mockRejectedValueOnce(new Error('guard probe unavailable'));
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = { action: 'cli-launch' as const, provider: 'openai-codex' as const };

    await expect(service.run(input)).resolves.toMatchObject({
      status: expect.not.stringMatching('blocked'),
    });
    await expect(service.run({ ...input, force: true })).resolves.toMatchObject({
      reasons: ['forced probe unavailable'],
      status: 'blocked',
    });
    const guard = new ProviderAccessGuard(service);
    const operation = vi.fn();
    await expect(
      guard.withAllowed({ action: 'cli-launch', provider: 'openai-codex' }, operation),
    ).rejects.toThrow('guard probe unavailable');
    expect(operation).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('forces a fresh check when the automatic event policy requests one', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = { action: 'cli-launch' as const, provider: 'openai-codex' as const };
    await service.run(input);
    const guard = new ProviderAccessGuard(service, (request) => request.action === 'cli-launch');

    await guard.withAllowed(input, () => undefined);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('admits ten fresh automatic launches together without superseding sibling conversations', async () => {
    let complete!: (value: ConnectivityObservation) => void;
    const signals: AbortSignal[] = [];
    const run = vi.fn<ProviderConnectivityProbe['run']>(
      (_provider, _action, _cwd, _scope, _target, signal) => {
        if (signal) signals.push(signal);
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    );
    const { acquireNetworkLease, leases } = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(createRoot()),
      probe: { run },
    });
    const guard = new ProviderAccessGuard(service, () => true);
    const input = {
      action: 'cli-launch' as const,
      cwd: 'D:\\Project',
      provider: 'openai-codex' as const,
    };
    const operations = Array.from({ length: 10 }, (_, index) => vi.fn(() => index));
    const outcomes = Promise.allSettled(
      operations.map((operation) => guard.withAllowed(input, operation)),
    );

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    complete(successfulObservation());
    expect(await outcomes).toEqual(operations.map((_, value) => ({ status: 'fulfilled', value })));
    for (const operation of operations) expect(operation).toHaveBeenCalledOnce();
    for (const lease of leases) expect(lease.release).toHaveBeenCalledOnce();

    // A later launch must still run the configured fresh check, not use the completed cache.
    const next = guard.withAllowed(input, () => 'next');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    complete(successfulObservation());
    await expect(next).resolves.toBe('next');
  });

  it('automatically rechecks one transient first-launch failure before blocking the launch', async () => {
    const root = createRoot();
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ...failedRequiredObservation('连接超时。'),
        paths: [],
      })
      .mockResolvedValueOnce(successfulObservation());
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore,
      probe: { run },
    });
    const guard = new ProviderAccessGuard(service);
    const operation = vi.fn(async (result: NetworkPreflightResult) => result.status);

    await expect(
      guard.withAllowed({ action: 'cli-launch', provider: 'openai-codex' }, operation),
    ).resolves.not.toBe('blocked');

    expect(run).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledOnce();
    expect(
      diagnosticsStore
        .getView()
        .entries.map((entry) =>
          entry.schemaVersion === 2 ? entry.providerConnectivity.status : 'legacy',
        ),
    ).toEqual([expect.not.stringMatching('blocked'), 'blocked']);
  });

  it('cancels the transient launch retry before starting a second probe', async () => {
    const root = createRoot();
    const run = vi.fn(async () => failedRequiredObservation('连接超时。'));
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const guard = new ProviderAccessGuard(service);
    const operation = vi.fn();
    const controller = new AbortController();
    const abortError = new Error('launch cancelled');

    const pending = guard.withAllowed(
      { action: 'cli-launch', provider: 'openai-codex' },
      operation,
      controller.signal,
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    controller.abort(abortError);

    await expect(pending).rejects.toBe(abortError);
    expect(run).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not retry a TLS failure as if it were a transient cold-start failure', async () => {
    const root = createRoot();
    const run = vi.fn(async () => failedRequiredObservation('TLS 证书校验失败。'));
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const guard = new ProviderAccessGuard(service);
    const operation = vi.fn();

    await expect(
      guard.withAllowed({ action: 'cli-launch', provider: 'openai-codex' }, operation),
    ).rejects.toBeInstanceOf(Error);

    expect(run).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
  });

  it('invalidates stale in-flight work without persisting it as the current result', async () => {
    const root = createRoot();
    let release: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          release = resolve;
        }),
    );
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore,
      probe: { run },
    });
    const operation = service.run({
      action: 'background',
      provider: 'openai-codex',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    service.invalidate('network-changed');
    release?.(successfulObservation());
    await expect(operation).rejects.toBeInstanceOf(NetworkPreflightSupersededError);

    expect(diagnosticsStore.getView().entries).toHaveLength(0);
  });

  it('aborts only obsolete overlap work and releases its lease before the fresh run settles', async () => {
    const root = createRoot();
    const signals: AbortSignal[] = [];
    let finishFresh: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi.fn((...args: unknown[]): Promise<ConnectivityObservation> => {
      const signal = args[5];
      if (!(signal instanceof AbortSignal)) {
        return Promise.reject(new Error('authoritative signal missing'));
      }
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise<ConnectivityObservation>((_resolve, reject) => {
          const rejectAbort = (): void => reject(signal.reason);
          if (signal.aborted) {
            rejectAbort();
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true });
          }
        });
      }
      return new Promise<ConnectivityObservation>((resolve) => {
        finishFresh = resolve;
      });
    });
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const leaseHarness = createNetworkLeaseHarness();
    const onResult = vi.fn();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore,
      onResult,
      probe: { run },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };
    const staleOperation = vi.fn((result: NetworkPreflightResult) => result);

    const stale = service.runWithLease(input, undefined, staleOperation);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const staleAssertion = expect(stale).rejects.toBeInstanceOf(NetworkPreflightSupersededError);

    service.invalidate('proxy-changed');
    const fresh = service.run(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await staleAssertion;
    expect(staleOperation).not.toHaveBeenCalled();
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
    expect(leaseHarness.leases[1]?.release).not.toHaveBeenCalled();
    expect(diagnosticsStore.getView().entries).toHaveLength(0);

    finishFresh?.(successfulObservation());
    const freshResult = await fresh;

    expect(leaseHarness.leases[1]?.release).toHaveBeenCalledOnce();
    expect(diagnosticsStore.getView().entries).toHaveLength(1);
    expect(diagnosticsStore.getView().entries[0]).toMatchObject({
      generation: 1,
      mainRunId: freshResult.mainRunId,
    });
    const finalResults = onResult.mock.calls
      .map(([result]) => result as NetworkPreflightResult)
      .filter(({ status }) => status !== 'testing');
    expect(finalResults).toEqual([freshResult]);

    await expect(service.run(input)).resolves.toBe(freshResult);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('holds the route lease until aborted cancellable probe cleanup settles', async () => {
    const root = createRoot();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanupStarted = vi.fn();
    const applicationRequest = vi.fn(
      (_url: string, signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            cleanupStarted();
            void cleanup.then(() => reject(signal?.reason));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const probe = new ProviderConnectivityProbe({
      applicationRequest,
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const leaseHarness = createNetworkLeaseHarness();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe,
    });
    const operation = service.run(
      { action: 'first-request', provider: 'openai-api' },
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
    );

    await vi.waitFor(() => expect(applicationRequest).toHaveBeenCalledOnce());
    service.invalidate('proxy-changed');
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledOnce());
    expect(leaseHarness.leases[0]?.release).not.toHaveBeenCalled();

    finishCleanup();

    await expect(operation).rejects.toBeInstanceOf(NetworkPreflightSupersededError);
    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
  });

  it('releases its lease at the deadline and ignores late PAC and DNS completions', async () => {
    const root = createRoot();
    let finishDns!: (value: Array<{ address: string; family: 4 | 6 }>) => void;
    let finishProxy!: (value: string) => void;
    const dnsCompleted = vi.fn();
    const proxyCompleted = vi.fn();
    const dnsOutcome = new Promise<Array<{ address: string; family: 4 | 6 }>>((resolve) => {
      finishDns = resolve;
    });
    const proxyOutcome = new Promise<string>((resolve) => {
      finishProxy = resolve;
    });
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({
        contentType: 'application/json',
        redirects: [],
        status: 204,
      }),
      dnsLookup: () =>
        dnsOutcome.then((addresses) => {
          dnsCompleted();
          return addresses;
        }),
      overallTimeoutMs: 10,
      resolveProxy: () =>
        proxyOutcome.then((resolved) => {
          proxyCompleted();
          return resolved;
        }),
    });
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const leaseHarness = createNetworkLeaseHarness();
    const onResult = vi.fn();
    const service = new NetworkPreflightService({
      acquireNetworkLease: leaseHarness.acquireNetworkLease,
      diagnosticsStore,
      onResult,
      probe,
    });

    await service.run(
      { action: 'first-request', provider: 'openai-api' },
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
    );

    expect(leaseHarness.leases[0]?.release).toHaveBeenCalledOnce();
    expect(dnsCompleted).not.toHaveBeenCalled();
    expect(proxyCompleted).not.toHaveBeenCalled();
    expect(diagnosticsStore.getView().entries).toHaveLength(1);
    expect(onResult).toHaveBeenCalledTimes(2);

    finishDns([{ address: '203.0.113.10', family: 4 }]);
    finishProxy('DIRECT');
    await vi.waitFor(() => {
      expect(dnsCompleted).toHaveBeenCalledOnce();
      expect(proxyCompleted).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(diagnosticsStore.getView().entries).toHaveLength(1);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh check for callers that arrive after an invalidation', async () => {
    const root = createRoot();
    const releases: ((value: ConnectivityObservation) => void)[] = [];
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          releases.push(resolve);
        }),
    );
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };

    const stale = service.run(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    // Proxy or endpoint settings changed, so anything computed under the old configuration is void.
    service.invalidate('proxy-changed');

    // Reusing the superseded in-flight promise here hands the new caller a verdict computed with
    // the configuration they just replaced.
    const fresh = service.run(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(fresh).not.toBe(stale);

    for (const release of releases) {
      release(successfulObservation());
    }
    await expect(stale).rejects.toBeInstanceOf(NetworkPreflightSupersededError);
    await expect(fresh).resolves.toMatchObject({ status: expect.not.stringMatching('blocked') });
  });

  it('keeps one canonical relative cwd across a superseded launch guard retry', async () => {
    const root = createRoot();
    const initialProcessCwd = createRoot();
    const changedProcessCwd = createRoot();
    const originalProcessCwd = process.cwd();
    let releaseFirst: ((value: ConnectivityObservation) => void) | undefined;

    try {
      process.chdir(initialProcessCwd);
      const canonicalCwd = path.resolve('relative-project');
      const run = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ConnectivityObservation>((resolve) => {
              releaseFirst = resolve;
            }),
        )
        .mockResolvedValue(successfulObservation());
      const service = new NetworkPreflightService({
        ...networkLeaseOptions(),
        diagnosticsStore: new NetworkDiagnosticsStore(root),
        probe: { run },
      });
      const guard = new ProviderAccessGuard(service);
      const operationCwds: (string | undefined)[] = [];
      const operation = vi.fn((result: NetworkPreflightResult) => {
        operationCwds.push(result.canonicalCwd);
        return 'started';
      });

      const assertion = guard.withAllowed(
        {
          action: 'cli-launch',
          cwd: 'relative-project',
          networkScope: 'conversation',
          provider: 'openai-codex',
        },
        operation,
      );
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
      process.chdir(changedProcessCwd);
      service.invalidate('proxy-changed');
      releaseFirst?.(successfulObservation());

      await expect(assertion).resolves.toBe('started');
      expect(operation).toHaveBeenCalledOnce();
      expect(operationCwds).toEqual([canonicalCwd]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(
        1,
        'openai-codex',
        'cli-launch',
        homedir(),
        'conversation',
        undefined,
        expect.any(AbortSignal),
      );
      expect(run).toHaveBeenNthCalledWith(
        2,
        'openai-codex',
        'cli-launch',
        homedir(),
        'conversation',
        undefined,
        expect.any(AbortSignal),
      );
    } finally {
      process.chdir(originalProcessCwd);
      releaseFirst?.(successfulObservation());
    }
  });

  it('keeps the exact application target on a superseded guard retry', async () => {
    const root = createRoot();
    let releaseFirst: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ConnectivityObservation>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(successfulObservation());
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const guard = new ProviderAccessGuard(service);
    const target = {
      process: 'application' as const,
      url: 'https://api.openai.com/v1/chat/completions',
    };

    const assertion = guard.withAllowed(
      {
        action: 'first-request',
        networkScope: 'conversation',
        provider: 'openai-api',
        target,
      },
      () => 'started',
    );
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    target.url = 'https://example.test/replaced';
    service.invalidate('conversation-proxy-changed');
    releaseFirst?.(successfulObservation());

    await expect(assertion).resolves.toBe('started');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      1,
      'openai-api',
      'first-request',
      homedir(),
      'conversation',
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      expect.any(AbortSignal),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'openai-api',
      'first-request',
      homedir(),
      'conversation',
      {
        process: 'application',
        url: 'https://api.openai.com/v1/chat/completions',
      },
      expect.any(AbortSignal),
    );
  });

  it('does not retry an operation that throws a superseded error after starting', async () => {
    const root = createRoot();
    const run = vi.fn(async () => successfulObservation());
    const service = new NetworkPreflightService({
      ...networkLeaseOptions(),
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const guard = new ProviderAccessGuard(service);
    const operationError = new NetworkPreflightSupersededError(0, 1);
    const operation = vi.fn(async () => {
      throw operationError;
    });

    await expect(
      guard.withAllowed({ action: 'cli-launch', provider: 'openai-codex' }, operation),
    ).rejects.toBe(operationError);
    expect(operation).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('fails closed when the launch guard is superseded twice', async () => {
    const runWithLease = vi.fn(async () => {
      throw new NetworkPreflightSupersededError(0, 1);
    });
    const guard = new ProviderAccessGuard({ runWithLease } as unknown as NetworkPreflightService);
    const operation = vi.fn();

    await expect(
      guard.withAllowed({ action: 'cli-launch', provider: 'openai-codex' }, operation),
    ).rejects.toBeInstanceOf(NetworkPreflightSupersededError);
    expect(operation).not.toHaveBeenCalled();
    expect(runWithLease).toHaveBeenCalledTimes(2);
  });
});
