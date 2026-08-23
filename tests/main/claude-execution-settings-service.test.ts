import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClaudeExecutionProfile } from '../../src/shared/claude/execution-profiles';
import { resolveClaudeExecutionCapabilities } from '../../src/main/claude/execution-settings-capabilities';
import { ClaudeExecutionSettingsService } from '../../src/main/claude/execution-settings-service';
import { ClaudeExecutionSettingsStore } from '../../src/main/claude/execution-settings-store';

const fixtureRoots: string[] = [];

const createDeferred = <Value>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createFixture = (version = '2.1.219') => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-execution-service-'));
  fixtureRoots.push(fixtureRoot);
  const store = new ClaudeExecutionSettingsStore(fixtureRoot);
  const service = new ClaudeExecutionSettingsService({
    capabilityResolver: resolveClaudeExecutionCapabilities,
    installationProvider: {
      getInstallation: () => ({ installed: true, version }),
    },
    profileLookup: getClaudeExecutionProfile,
    recommendationInputProvider: {
      getRecommendationInput: () => ({
        availableMemoryBytes: 32 * 1024 ** 3,
        benchmark: { stableConcurrentSubagents: 20, stableToolUseConcurrency: 24 },
        logicalCpuCount: 24,
        rateLimit: { remainingRatio: 0.75 },
      }),
    },
    store,
  });
  return { service, store };
};

describe('Claude execution settings service', () => {
  it('keeps complete launch environments out of shared contracts and exports', () => {
    for (const sourcePath of [
      'src/shared/contracts/claude-execution-settings.ts',
      'src/shared/contracts/index.ts',
    ]) {
      const source = readFileSync(path.resolve(sourcePath), 'utf8');
      for (const forbidden of [
        'ClaudeExecutionCapabilityResolution',
        'ClaudeExecutionEnvironmentPair',
        'ClaudeExecutionLaunchResolution',
        'processEnvironment',
        'settingsEnvironment',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('composes get, update, reset, and recommendation without a project or open session', async () => {
    const { service, store } = createFixture();

    expect((await service.get()).requested).toEqual({ mode: 'claude-default' });
    expect((await service.update({ mode: 'profile', profileId: 'balanced' })).requested).toEqual({
      mode: 'profile',
      profileId: 'balanced',
    });
    const restored = await service.resetToClaudeDefault();
    expect(restored.requested).toEqual({ mode: 'claude-default' });
    expect(
      Object.values(restored.effective).every((setting) => setting.operation.kind === 'delete'),
    ).toBe(true);
    const persistedDefault = await service.get();
    expect(
      Object.values(persistedDefault.effective).every(
        (setting) => setting.operation.kind === 'omit',
      ),
    ).toBe(true);

    const recommended = await service.useRecommended();
    expect(recommended.requested).toEqual({ mode: 'profile', profileId: 'best-performance' });
    expect(store.get().requested).toEqual(recommended.requested);
  });

  it('captures one immutable launch snapshot for terminal and native environment parity', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-execution-snapshot-'));
    fixtureRoots.push(fixtureRoot);
    const store = new ClaudeExecutionSettingsStore(fixtureRoot);
    await store.set({
      mode: 'custom',
      values: {
        concurrentSubagents: 7,
        spawnDepth: 2,
        toolSearch: 'auto:20',
        toolUseConcurrency: 9,
      },
    });

    let finishInstallation: ((value: { installed: boolean; version: string }) => void) | undefined;
    const installation = new Promise<{ installed: boolean; version: string }>((resolve) => {
      finishInstallation = resolve;
    });
    const service = new ClaudeExecutionSettingsService({
      capabilityResolver: resolveClaudeExecutionCapabilities,
      installationProvider: { getInstallation: () => installation },
      profileLookup: getClaudeExecutionProfile,
      store,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(200);
    const input = {
      evidence: {
        toolSearch: [
          {
            expiresAt: 300,
            model: 'claude-opus-5',
            routeId: 'route-a',
            source: 'fresh exact route-model fixture',
            supported: true,
            verifiedAt: 100,
          },
        ],
        toolUseConcurrency: [
          {
            exactVersion: '2.1.219',
            source: 'exact-version fixture',
            supported: true,
            verifiedAt: 100,
          },
        ],
      },
      processEnvironment: { ENABLE_TOOL_SEARCH: 'old-process', PROCESS_ONLY: 'yes' },
      route: { model: 'claude-opus-5', routeId: 'route-a' },
      settingsEnvironment: { ENABLE_TOOL_SEARCH: 'old-settings', SETTINGS_ONLY: 'yes' },
    };

    const pending = service.resolveLaunch(input);
    // Provider latency must not move evidence evaluation past the invocation-time expiry boundary.
    now.mockReturnValue(400);
    // Mutations after the call must not tear the launch across store, route evidence, or env sources.
    await store.set({ mode: 'profile', profileId: 'token-saver' });
    input.route.routeId = 'mutated-route';
    input.processEnvironment.ENABLE_TOOL_SEARCH = 'mutated-process';
    input.settingsEnvironment.ENABLE_TOOL_SEARCH = 'mutated-settings';
    input.evidence.toolSearch[0]!.supported = false;
    finishInstallation?.({ installed: true, version: '2.1.219' });

    const launch = await pending;
    expect(launch.requested).toMatchObject({ mode: 'custom' });
    const managedProcess = Object.fromEntries(
      Object.entries(launch.environments.processEnvironment).filter(
        ([key]) => key.startsWith('CLAUDE_CODE_') || key === 'ENABLE_TOOL_SEARCH',
      ),
    );
    const managedSettings = Object.fromEntries(
      Object.entries(launch.environments.settingsEnvironment).filter(
        ([key]) => key.startsWith('CLAUDE_CODE_') || key === 'ENABLE_TOOL_SEARCH',
      ),
    );
    expect(managedProcess).toEqual({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '7',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2',
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '9',
      ENABLE_TOOL_SEARCH: 'auto:20',
    });
    expect(managedSettings).toEqual(managedProcess);
    expect(launch.environments.processEnvironment.PROCESS_ONLY).toBe('yes');
    expect(launch.environments.settingsEnvironment.SETTINGS_ONLY).toBe('yes');
    expect(Object.isFrozen(launch)).toBe(true);
    expect(Object.isFrozen(launch.effective.toolSearch.source)).toBe(true);
    expect(Object.isFrozen(launch.environments.processEnvironment)).toBe(true);
  });

  it('surfaces requested, default, effective, status, reason, and source separately', async () => {
    const { service } = createFixture('2.1.218');
    const view = await service.update({ mode: 'profile', profileId: 'balanced' });

    expect(view.effective.spawnDepth).toMatchObject({
      defaultValue: 1,
      effectiveValue: 3,
      requestedValue: 3,
      source: { kind: 'version-matrix' },
      status: 'supported',
    });
    expect(view.effective.spawnDepth.reason).toContain('默认值');
    expect(view.installation.version).toBe('2.1.218');
  });

  it('serializes update, reset, and recommendation persistence in invocation order', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-execution-fifo-'));
    fixtureRoots.push(fixtureRoot);
    const store = new ClaudeExecutionSettingsStore(fixtureRoot);
    const installations = Array.from({ length: 3 }, () =>
      createDeferred<{ installed: boolean; version: string }>(),
    );
    let installationCalls = 0;
    const service = new ClaudeExecutionSettingsService({
      capabilityResolver: resolveClaudeExecutionCapabilities,
      installationProvider: {
        getInstallation: () => {
          const installation = installations[installationCalls];
          installationCalls += 1;
          if (!installation) {
            throw new Error('unexpected installation request');
          }
          return installation.promise;
        },
      },
      profileLookup: getClaudeExecutionProfile,
      recommendationInputProvider: {
        getRecommendationInput: () => ({
          availableMemoryBytes: 4 * 1024 ** 3,
          logicalCpuCount: 4,
        }),
      },
      store,
    });

    const updated = service.update({ mode: 'profile', profileId: 'balanced' });
    const reset = service.resetToClaudeDefault();
    const recommended = service.useRecommended();

    await Promise.resolve();
    expect(installationCalls).toBe(1);
    expect(store.get().requested).toEqual({ mode: 'claude-default' });

    installations[0]!.resolve({ installed: true, version: '2.1.219' });
    expect((await updated).requested).toEqual({ mode: 'profile', profileId: 'balanced' });
    expect(store.get().requested).toEqual({ mode: 'profile', profileId: 'balanced' });
    await Promise.resolve();
    expect(installationCalls).toBe(2);

    installations[1]!.resolve({ installed: true, version: '2.1.219' });
    const resetView = await reset;
    expect(resetView.requested).toEqual({ mode: 'claude-default' });
    expect(
      Object.values(resetView.effective).every((setting) => setting.operation.kind === 'delete'),
    ).toBe(true);
    expect(store.get().requested).toEqual({ mode: 'claude-default' });
    await Promise.resolve();
    await Promise.resolve();
    expect(installationCalls).toBe(3);

    installations[2]!.resolve({ installed: true, version: '2.1.219' });
    expect((await recommended).requested).toEqual({
      mode: 'profile',
      profileId: 'token-saver',
    });
    expect(store.get().requested).toEqual({ mode: 'profile', profileId: 'token-saver' });
  });

  it('continues the mutation FIFO after a deferred provider rejection', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-execution-recovery-'));
    fixtureRoots.push(fixtureRoot);
    const store = new ClaudeExecutionSettingsStore(fixtureRoot);
    const installations = Array.from({ length: 2 }, () =>
      createDeferred<{ installed: boolean; version: string }>(),
    );
    let installationCalls = 0;
    const service = new ClaudeExecutionSettingsService({
      capabilityResolver: resolveClaudeExecutionCapabilities,
      installationProvider: {
        getInstallation: () => {
          const installation = installations[installationCalls];
          installationCalls += 1;
          if (!installation) {
            throw new Error('unexpected installation request');
          }
          return installation.promise;
        },
      },
      profileLookup: getClaudeExecutionProfile,
      store,
    });

    const rejected = service.update({ mode: 'profile', profileId: 'balanced' });
    const recovered = service.update({ mode: 'profile', profileId: 'token-saver' });
    const rejection = expect(rejected).rejects.toThrow('installation unavailable');

    await Promise.resolve();
    expect(installationCalls).toBe(1);
    installations[0]!.reject(new Error('installation unavailable'));
    await rejection;
    expect(store.get().requested).toEqual({ mode: 'claude-default' });

    await Promise.resolve();
    expect(installationCalls).toBe(2);
    installations[1]!.resolve({ installed: true, version: '2.1.219' });
    expect((await recovered).requested).toEqual({
      mode: 'profile',
      profileId: 'token-saver',
    });
    expect(store.get().requested).toEqual({ mode: 'profile', profileId: 'token-saver' });
  });

  it('does not persist update or reset when pre-persistence resolution fails', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-execution-transaction-'));
    fixtureRoots.push(fixtureRoot);
    const store = new ClaudeExecutionSettingsStore(fixtureRoot);
    await store.set({ mode: 'profile', profileId: 'balanced' });

    const rejectedProviderService = new ClaudeExecutionSettingsService({
      capabilityResolver: resolveClaudeExecutionCapabilities,
      installationProvider: {
        getInstallation: () => Promise.reject(new Error('installation unavailable')),
      },
      profileLookup: getClaudeExecutionProfile,
      store,
    });
    await expect(
      rejectedProviderService.update({ mode: 'profile', profileId: 'token-saver' }),
    ).rejects.toThrow('installation unavailable');
    expect(store.get().requested).toEqual({ mode: 'profile', profileId: 'balanced' });

    const throwingResolverService = new ClaudeExecutionSettingsService({
      capabilityResolver: () => {
        throw new Error('capability resolution failed');
      },
      installationProvider: {
        getInstallation: () => ({ installed: true, version: '2.1.219' }),
      },
      profileLookup: getClaudeExecutionProfile,
      store,
    });
    await expect(throwingResolverService.resetToClaudeDefault()).rejects.toThrow(
      'capability resolution failed',
    );
    expect(store.get().requested).toEqual({ mode: 'profile', profileId: 'balanced' });
  });
});
