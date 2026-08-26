import { describe, expect, it } from 'vitest';
import type { StartupModelConnectionState } from '../../src/shared/contracts';
import { settle, withRenderer } from '../helpers/renderer-interaction-fixture';

const connectingState = (overrides: Partial<StartupModelConnectionState> = {}) => {
  const now = Date.now();
  return {
    active: true,
    cancelAvailableAt: now + 120_000,
    detail: '正在真实验证 ChatGPT 官方订阅。',
    forceStopAt: now + 300_000,
    phase: 'connecting' as const,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
};

describe('startup model connection overlay', () => {
  it('locks and blurs the whole connection page while preserving progress across tab switches', async () => {
    let state = connectingState();
    await withRenderer(
      {
        getStartupModelConnection: async () => state,
      },
      async (harness) => {
        await settle(harness);
        const page = harness.query<HTMLElement>("[data-rail-page='connection']");
        const overlay = harness.query<HTMLElement>('#startup-model-connection');
        const heading = harness.query<HTMLElement>('.connection-heading');

        expect(page.dataset.startupConnection).toBe('active');
        expect(page.getAttribute('aria-busy')).toBe('true');
        expect(overlay.hidden).toBe(false);
        expect(heading.inert).toBe(true);
        expect(harness.query('#startup-model-connection-title').textContent).toBe('正在接入模型');
        expect(harness.query('#startup-model-connection-detail').textContent).toContain('ChatGPT');
        expect(harness.query<HTMLButtonElement>('#cancel-startup-model-connection').hidden).toBe(
          true,
        );

        harness.click("[data-rail-tab='connection']");
        harness.click("[data-rail-tab='projects']");
        harness.click("[data-rail-tab='connection']");
        expect(overlay.hidden).toBe(false);
        expect(page.dataset.startupConnection).toBe('active');

        state = connectingState({
          cancelAvailableAt: Date.now() - 1,
          updatedAt: state.updatedAt + 1,
        });
        harness.emit('onStartupModelConnectionChanged', state);
        expect(harness.query<HTMLButtonElement>('#cancel-startup-model-connection').hidden).toBe(
          false,
        );
      },
    );
  });

  it('cancels through the main process and restores the original interactive page only after rollback', async () => {
    const active = connectingState({ cancelAvailableAt: Date.now() - 1 });
    const cancelled: StartupModelConnectionState = {
      active: false,
      detail: '启动模型接入已取消，原接入保持不变。',
      finishedAt: active.updatedAt + 2,
      phase: 'cancelled',
      startedAt: active.startedAt,
      updatedAt: active.updatedAt + 2,
    };
    await withRenderer(
      {
        cancelStartupModelConnection: async () => ({
          message: '启动模型接入已取消。',
          ok: true,
          state: cancelled,
        }),
        getStartupModelConnection: async () => active,
      },
      async (harness) => {
        await settle(harness);
        harness.click('#cancel-startup-model-connection');
        expect(harness.query<HTMLButtonElement>('#cancel-startup-model-connection').disabled).toBe(
          true,
        );

        await settle(harness);
        const page = harness.query<HTMLElement>("[data-rail-page='connection']");
        expect(harness.method('cancelStartupModelConnection')).toHaveBeenCalledOnce();
        expect(harness.query<HTMLElement>('#startup-model-connection').hidden).toBe(true);
        expect(page.dataset.startupConnection).toBe('idle');
        expect(page.getAttribute('aria-busy')).toBe('false');
        expect(harness.query<HTMLElement>('.connection-heading').inert).toBe(false);
        expect(harness.query('#toast').textContent).toContain('原接入保持不变');
      },
    );
  });

  it('rolls the UI back to an operable state when reading main-process progress fails', async () => {
    await withRenderer(
      {
        getStartupModelConnection: async () => {
          throw new Error('fixture IPC failure');
        },
      },
      async (harness) => {
        await settle(harness);
        const page = harness.query<HTMLElement>("[data-rail-page='connection']");
        expect(harness.query<HTMLElement>('#startup-model-connection').hidden).toBe(true);
        expect(page.dataset.startupConnection).toBe('idle');
        expect(harness.query<HTMLElement>('.connection-heading').inert).toBe(false);
        expect(harness.query('#toast').textContent?.trim()).not.toBe('');
      },
    );
  });

  it('does not let a delayed initial snapshot overwrite a newer progress event', async () => {
    let resolveInitial!: (state: StartupModelConnectionState) => void;
    const initial = new Promise<StartupModelConnectionState>((resolve) => {
      resolveInitial = resolve;
    });
    const oldState = connectingState({ detail: '旧的读取阶段', updatedAt: 10 });
    const newState = connectingState({ detail: '新的真实验证阶段', updatedAt: 20 });
    await withRenderer(
      {
        getStartupModelConnection: () => initial,
      },
      async (harness) => {
        harness.emit('onStartupModelConnectionChanged', newState);
        resolveInitial(oldState);
        await settle(harness);

        expect(harness.query('#startup-model-connection-detail').textContent).toBe(
          '新的真实验证阶段',
        );
        expect(harness.query<HTMLElement>('#startup-model-connection').hidden).toBe(false);
      },
    );
  });
});
