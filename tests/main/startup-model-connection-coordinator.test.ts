import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupModelConnectionCoordinator } from '../../src/main/app/startup-model-connection-coordinator';

afterEach(() => {
  vi.useRealTimers();
});

describe('startup model connection coordinator', () => {
  it('hides cancellation authority until the configured threshold and waits for rollback', async () => {
    vi.useFakeTimers();
    const coordinator = new StartupModelConnectionCoordinator();
    const run = coordinator.run({ cancelAfterMs: 20, forceStopAfterMs: 80 }, async (context) => {
      context.updateDetail('正在真实验证模型。');
      return new Promise<'cancelled'>((resolve) => {
        context.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
      });
    });

    expect(coordinator.getState()).toMatchObject({
      active: true,
      detail: '正在真实验证模型。',
      phase: 'connecting',
    });
    await expect(coordinator.cancel('user')).resolves.toMatchObject({ ok: false });

    await vi.advanceTimersByTimeAsync(20);
    await expect(coordinator.cancel('user')).resolves.toMatchObject({
      ok: true,
      state: { active: false, phase: 'cancelled' },
    });
    await expect(run).resolves.toBe('cancelled');
  });

  it('aborts at the hard deadline and reports a timed-out terminal state', async () => {
    vi.useFakeTimers();
    const coordinator = new StartupModelConnectionCoordinator();
    const run = coordinator.run(
      { cancelAfterMs: 10, forceStopAfterMs: 40 },
      async (context) =>
        new Promise<'cancelled'>((resolve) => {
          context.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
        }),
    );

    await vi.advanceTimersByTimeAsync(40);
    await expect(run).resolves.toBe('cancelled');
    expect(coordinator.getState()).toMatchObject({
      active: false,
      phase: 'timed-out',
    });
    expect(coordinator.getState().detail).toContain('原接入保持不变');
  });

  it('lets controlled quit bypass the visible cancellation threshold and waits for rollback', async () => {
    vi.useFakeTimers();
    const coordinator = new StartupModelConnectionCoordinator();
    const run = coordinator.run(
      { cancelAfterMs: 120_000, forceStopAfterMs: 300_000 },
      (context) =>
        new Promise<'cancelled'>((resolve) => {
          context.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
        }),
    );

    await expect(coordinator.cancel('shutdown')).resolves.toMatchObject({
      ok: true,
      state: { active: false, phase: 'cancelled' },
    });
    await expect(run).resolves.toBe('cancelled');
    expect(coordinator.getState().detail).toContain('软件退出');
  });

  it('publishes a connected state only after the operation really completes', async () => {
    const coordinator = new StartupModelConnectionCoordinator();
    const states: string[] = [];
    coordinator.onChanged((state) => states.push(`${state.phase}:${state.active}`));

    await expect(
      coordinator.run({ cancelAfterMs: 10, forceStopAfterMs: 20 }, async (context) => {
        context.updateProgress({
          accountLabel: 'ChatGPT 官方订阅 · person@example.com',
          detail: '正在提交配置。',
          step: '提交接入配置',
        });
        return 'restored';
      }),
    ).resolves.toBe('restored');

    expect(states).toEqual(['connecting:true', 'connecting:true', 'connected:false']);
    expect(coordinator.getState().detail).toContain('已完成验证并接入');
  });

  it('keeps timestamps monotonic and isolates a failing presentation observer', async () => {
    const coordinator = new StartupModelConnectionCoordinator();
    const updatedAt: number[] = [];
    coordinator.onChanged(() => {
      throw new Error('fixture observer failure');
    });
    coordinator.onChanged((state) => updatedAt.push(state.updatedAt));

    await expect(
      coordinator.run({ cancelAfterMs: 10, forceStopAfterMs: 20 }, async (context) => {
        context.updateDetail('正在读取。');
        context.updateDetail('正在验证。');
        return 'restored';
      }),
    ).resolves.toBe('restored');

    expect(updatedAt).toHaveLength(4);
    expect(updatedAt.every((value, index) => index === 0 || value > updatedAt[index - 1]!)).toBe(
      true,
    );
  });
});
