import { describe, expect, it, vi } from 'vitest';
import { createRendererHarness } from '../helpers/renderer-harness';

const pendingOnboarding = {
  completedSteps: [] as Array<'engine' | 'model' | 'prepare' | 'project' | 'ready'>,
  currentStep: 'engine' as const,
  flowVersion: 2,
  status: 'pending' as const,
};

describe('onboarding flow', () => {
  it('selects engine and model independently, including the compact domestic model picker', async () => {
    const updateOnboardingProgress = vi.fn(async (input) => ({
      ...input,
      flowVersion: 2,
      status: 'in-progress' as const,
    }));
    const harness = await createRendererHarness({
      getOnboardingState: vi.fn(async () => pendingOnboarding),
      skipOnboarding: vi.fn(async () => ({ ...pendingOnboarding, status: 'skipped' as const })),
      updateOnboardingProgress,
    });
    try {
      await harness.flush();
      const shell = harness.query<HTMLElement>('#onboarding-shell');
      expect(shell.hidden).toBe(false);
      expect(harness.query('[data-onboarding-step="engine"]').textContent).toContain(
        '选择工作引擎',
      );
      expect(harness.query('[data-onboarding-engine="claude"]').textContent).toContain('推荐');

      harness.click('[data-onboarding-engine="codex"]');
      await harness.flush();
      expect(harness.query('#onboarding-engine-next')).not.toHaveProperty('disabled', true);
      expect(updateOnboardingProgress).toHaveBeenCalledWith(
        expect.objectContaining({ currentStep: 'engine', engine: 'codex' }),
      );

      harness.click('#onboarding-engine-next');
      await harness.flush();
      expect(harness.query('[data-onboarding-step="model"]').hidden).toBe(false);
      harness.click('[data-onboarding-model-choice="domestic"]');
      await harness.flush();
      const domestic = harness.query<HTMLSelectElement>('#onboarding-domestic-model');
      expect(harness.query('#onboarding-domestic-model-picker').hidden).toBe(false);
      expect(harness.query('#onboarding-domestic-model-hint').textContent).toContain(
        '当前已选择 DeepSeek',
      );
      domestic.value = 'qwen-cn';
      domestic.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
      await harness.flush();
      expect(harness.query('#onboarding-domestic-model-hint').textContent).toContain('通义千问');

      harness.click('#onboarding-model-next');
      await harness.flush();
      expect(harness.query('[data-onboarding-step="prepare"]').hidden).toBe(false);
      expect(harness.query('#onboarding-tool-status').textContent).toBe('项目后检测');

      harness.click('[data-onboarding-back="model"]');
      await harness.flush();
      expect(harness.query('[data-onboarding-step="model"]').hidden).toBe(false);
      expect(harness.query('#onboarding-viewport').getAttribute('data-direction')).toBe('backward');

      harness.click('#onboarding-dismiss');
      await harness.flush();
      harness
        .query('.onboarding-surface')
        .dispatchEvent(new harness.dom.window.Event('animationend', { bubbles: true }));
      expect(shell.hidden).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it('returns to settings after the inverse close transition', async () => {
    const harness = await createRendererHarness();
    try {
      harness.click('#open-connection-advanced');
      await harness.flush();
      harness.click('#settings-open-onboarding');
      await harness.flush();
      expect(harness.query('#connection-advanced-dialog').hasAttribute('open')).toBe(false);
      expect(harness.query('#onboarding-shell').hidden).toBe(false);

      harness.click('#onboarding-dismiss');
      await harness.flush();
      harness
        .query('.onboarding-surface')
        .dispatchEvent(new harness.dom.window.Event('animationend', { bubbles: true }));
      await harness.flush();
      expect(harness.query('#connection-advanced-dialog').hasAttribute('open')).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});
