import { describe, expect, it, vi } from 'vitest';
import { ClaudeLaunchHealthMonitor } from '../../src/main/network/claude-launch-health-monitor';
import type { NetworkPreflightResult } from '../../src/shared/contracts';

const result = (
  status: NetworkPreflightResult['providerConnectivity']['status'],
  checkedAt = 100,
  compatibilityStatus: NetworkPreflightResult['status'] = status,
): NetworkPreflightResult => {
  const providerConnectivity = {
    featureAccess: [{ action: 'background' as const, allowed: status !== 'blocked' }],
    probes: [],
    reasons: ['must never reach the display snapshot'],
    signals: [],
    status,
    summary: 'must never reach the display snapshot',
  };
  const advisoryEvidence = {
    paths: [],
    reasons: [],
    riskLevel: 'high' as const,
    riskScore: 90,
    signals: [],
    summary: 'advisory evidence must never reach the display snapshot',
  };
  return {
    action: 'background',
    advisoryEvidence,
    checkedAt,
    configurationRevision: 'main-only-revision',
    featureAccess: providerConnectivity.featureAccess,
    generation: 4,
    mainRunId: 9,
    networkScope: 'application',
    paths: advisoryEvidence.paths,
    probes: providerConnectivity.probes,
    provider: 'anthropic-claude',
    providerConnectivity,
    providerLabel: 'Anthropic Claude Code',
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: [],
    startedAt: checkedAt - 10,
    status: compatibilityStatus,
    summary: providerConnectivity.summary,
  };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('Claude launch health monitor', () => {
  it.each([false, true])(
    'does not start background probes when disabled (seeded: %s)',
    async (seeded) => {
      const run = vi.fn(async () => result('allowed'));
      const onSnapshot = vi.fn();
      const setTimer = vi.fn();
      const monitor = new ClaudeLaunchHealthMonitor({
        isCurrent: () => true,
        onSnapshot,
        preflight: { run },
        setTimer,
        shouldCheck: () => false,
      });
      monitor.start({
        cwd: 'D:\\Project',
        ...(seeded
          ? {
              initialEvidence: {
                checkedAt: 100,
                provider: 'anthropic-claude' as const,
                status: 'allowed' as const,
              },
            }
          : {}),
        provider: 'anthropic-claude',
        ptyGeneration: 1,
        runtimeLaunchGeneration: 1,
        sessionId: 'session-1',
      });
      await flush();
      expect(run).not.toHaveBeenCalled();
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(setTimer).not.toHaveBeenCalled();
      expect(monitor.activeCount()).toBe(0);
    },
  );

  it('drops an in-flight result and stops rescheduling after automatic checks are disabled', async () => {
    let enabled = true;
    let finish!: (value: NetworkPreflightResult) => void;
    const run = vi.fn(
      () =>
        new Promise<NetworkPreflightResult>((resolve) => {
          finish = resolve;
        }),
    );
    const onSnapshot = vi.fn();
    const setTimer = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      isCurrent: () => true,
      onSnapshot,
      preflight: { run },
      setTimer,
      shouldCheck: () => enabled,
    });
    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 1,
      runtimeLaunchGeneration: 1,
      sessionId: 'session-1',
    });
    enabled = false;
    finish(result('blocked'));
    await flush();
    expect(run).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    expect(monitor.activeCount()).toBe(0);
  });

  it('re-reads the switch before a previously scheduled background check', async () => {
    let enabled = true;
    let tick!: () => void;
    const run = vi.fn(async () => result('allowed'));
    const setTimer = vi.fn((callback: () => void) => {
      tick = callback;
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    });
    const monitor = new ClaudeLaunchHealthMonitor({
      isCurrent: () => true,
      onSnapshot: vi.fn(),
      preflight: { run },
      setTimer,
      shouldCheck: () => enabled,
    });
    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 1,
      runtimeLaunchGeneration: 1,
      sessionId: 'session-1',
    });
    await flush();
    enabled = false;
    tick();
    await flush();
    expect(run).toHaveBeenCalledOnce();
    expect(setTimer).toHaveBeenCalledOnce();
    expect(monitor.activeCount()).toBe(0);
  });

  it('checks immediately through NetworkPreflightService and publishes only advisory redacted state', async () => {
    const run = vi.fn(async () => result('blocked', 321));
    const onSnapshot = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      isCurrent: () => true,
      onSnapshot,
      preflight: { run },
      random: () => 0.5,
    });

    monitor.start({
      cwd: 'D:\\Secret\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 7,
      runtimeLaunchGeneration: 12,
      sessionId: 'session-1',
    });
    await flush();

    expect(run).toHaveBeenCalledWith({
      action: 'background',
      cwd: 'D:\\Secret\\Project',
      provider: 'anthropic-claude',
    });
    expect(onSnapshot).toHaveBeenCalledWith(
      {
        ptyGeneration: 7,
        runtimeLaunchGeneration: 12,
        sessionId: 'session-1',
      },
      {
        blocking: false,
        checkedAt: 321,
        detail: expect.stringMatching(/不会被中断/),
        headline: '运行中连接可能不可用',
        source: 'runtime',
        tone: 'error',
      },
    );
    const snapshot = onSnapshot.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('canonicalCwd');
    expect(snapshot).not.toHaveProperty('configurationRevision');
    expect(snapshot).not.toHaveProperty('generation');
    expect(snapshot).not.toHaveProperty('mainRunId');
    expect(snapshot).not.toHaveProperty('provider');
    expect(JSON.stringify(snapshot)).not.toContain('Secret');
    expect(JSON.stringify(snapshot)).not.toContain('must never reach the display snapshot');
    expect(JSON.stringify(snapshot)).not.toContain('advisory evidence must never reach');
    monitor.invalidateAll();
  });

  it('keeps allow and allow-with-notice healthy despite high advisory evidence and poisoned flat status', async () => {
    const timers: Array<{ callback: () => void; delay: number; unref: ReturnType<typeof vi.fn> }> =
      [];
    const setTimer = vi.fn((callback: () => void, delay: number) => {
      const timer = { callback, delay, unref: vi.fn() };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(result('allowed', 101, 'blocked'))
      .mockResolvedValueOnce(result('allowed_with_notice', 102, 'blocked'));
    const onSnapshot = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      concernBaseIntervalMs: 10,
      healthyIntervalMs: 100,
      isCurrent: () => true,
      jitterRatio: 0,
      maximumIntervalMs: 100,
      onSnapshot,
      preflight: { run },
      setTimer,
    });

    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 7,
      runtimeLaunchGeneration: 12,
      sessionId: 'session-1',
    });
    await flush();

    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.objectContaining({ checkedAt: 101, tone: 'success' }),
    );
    expect(timers[0]?.delay).toBe(100);

    timers[0]!.callback();
    await flush();
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.objectContaining({ checkedAt: 102, tone: 'success' }),
    );
    expect(timers[1]?.delay).toBe(100);
    monitor.invalidateAll();
  });

  it('seeds from the exact completed launch check without repeating a background probe', async () => {
    const timers: Array<{ callback: () => void; delay: number; unref: ReturnType<typeof vi.fn> }> =
      [];
    const setTimer = vi.fn((callback: () => void, delay: number) => {
      const timer = { callback, delay, unref: vi.fn() };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    });
    const run = vi.fn(async () => result('allowed', 456));
    const onSnapshot = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      healthyIntervalMs: 100,
      isCurrent: () => true,
      jitterRatio: 0,
      maximumIntervalMs: 100,
      onSnapshot,
      preflight: { run },
      setTimer,
    });

    monitor.start({
      cwd: 'D:\\Project',
      initialEvidence: {
        checkedAt: 321,
        provider: 'anthropic-claude',
        status: 'allowed',
      },
      provider: 'anthropic-claude',
      ptyGeneration: 7,
      runtimeLaunchGeneration: 12,
      sessionId: 'session-1',
    });
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.objectContaining({ blocking: false, checkedAt: 321, tone: 'success' }),
    );
    expect(timers[0]?.delay).toBe(100);
    expect(timers[0]?.unref).toHaveBeenCalledOnce();

    timers[0]!.callback();
    await flush();
    expect(run).toHaveBeenCalledOnce();
    monitor.invalidateAll();
  });

  it('does not publish or probe seeded evidence after exact-generation replacement', async () => {
    const run = vi.fn(async () => result('allowed'));
    const onSnapshot = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      isCurrent: () => false,
      onSnapshot,
      preflight: { run },
    });

    monitor.start({
      cwd: 'D:\\Project',
      initialEvidence: {
        checkedAt: 321,
        provider: 'anthropic-claude',
        status: 'allowed',
      },
      provider: 'anthropic-claude',
      ptyGeneration: 7,
      runtimeLaunchGeneration: 12,
      sessionId: 'session-1',
    });
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(monitor.activeCount()).toBe(0);
  });

  it('fences an in-flight result against exact runtime and PTY replacement', async () => {
    let resolveResult!: (value: NetworkPreflightResult) => void;
    const pending = new Promise<NetworkPreflightResult>((resolve) => {
      resolveResult = resolve;
    });
    let current = true;
    const onSnapshot = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      isCurrent: () => current,
      onSnapshot,
      preflight: { run: vi.fn(() => pending) },
    });

    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 2,
      runtimeLaunchGeneration: 3,
      sessionId: 'session-1',
    });
    current = false;
    resolveResult(result('allowed'));
    await flush();

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(monitor.activeCount()).toBe(0);
  });

  it('synchronously supersedes the same session and never publishes the older launch', async () => {
    let resolveFirst!: (value: NetworkPreflightResult) => void;
    const first = new Promise<NetworkPreflightResult>((resolve) => {
      resolveFirst = resolve;
    });
    const run = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(result('allowed', 202));
    const onSnapshot = vi.fn();
    const monitor = new ClaudeLaunchHealthMonitor({
      isCurrent: ({ runtimeLaunchGeneration }) => runtimeLaunchGeneration === 2,
      onSnapshot,
      preflight: { run },
    });

    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 1,
      runtimeLaunchGeneration: 1,
      sessionId: 'session-1',
    });
    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 2,
      runtimeLaunchGeneration: 2,
      sessionId: 'session-1',
    });
    await flush();
    resolveFirst(result('blocked', 101));
    await flush();

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      ptyGeneration: 2,
      runtimeLaunchGeneration: 2,
    });
    monitor.invalidateAll();
  });

  it('uses deterministic jittered backoff and unrefs every scheduled timer', async () => {
    const timers: Array<{
      callback: () => void;
      cleared: boolean;
      delay: number;
      unref: ReturnType<typeof vi.fn>;
    }> = [];
    const setTimer = vi.fn((callback: () => void, delay: number) => {
      const timer = { callback, cleared: false, delay, unref: vi.fn() };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    });
    const clearTimer = vi.fn((timer: NodeJS.Timeout) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(result('blocked', 1))
      .mockResolvedValueOnce(result('blocked', 2))
      .mockResolvedValueOnce(result('allowed', 3));
    const monitor = new ClaudeLaunchHealthMonitor({
      clearTimer,
      concernBaseIntervalMs: 10,
      healthyIntervalMs: 100,
      isCurrent: () => true,
      jitterRatio: 0.2,
      maximumIntervalMs: 100,
      onSnapshot: vi.fn(),
      preflight: { run },
      random: () => 0.5,
      setTimer,
    });

    monitor.start({
      cwd: 'D:\\Project',
      provider: 'anthropic-claude',
      ptyGeneration: 1,
      runtimeLaunchGeneration: 1,
      sessionId: 'session-1',
    });
    await flush();
    expect(timers[0]?.delay).toBe(10);
    expect(timers[0]?.unref).toHaveBeenCalledOnce();

    timers[0]!.callback();
    await flush();
    expect(timers[1]?.delay).toBe(20);
    expect(timers[1]?.unref).toHaveBeenCalledOnce();

    timers[1]!.callback();
    await flush();
    expect(timers[2]?.delay).toBe(100);
    expect(timers[2]?.unref).toHaveBeenCalledOnce();

    monitor.invalidateExact({
      ptyGeneration: 99,
      runtimeLaunchGeneration: 99,
      sessionId: 'session-1',
    });
    expect(monitor.activeCount()).toBe(1);
    monitor.invalidateExact({
      ptyGeneration: 1,
      runtimeLaunchGeneration: 1,
      sessionId: 'session-1',
    });
    expect(monitor.activeCount()).toBe(0);
    expect(clearTimer).toHaveBeenCalledWith(timers[2]);
  });
});
