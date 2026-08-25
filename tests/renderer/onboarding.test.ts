import { describe, expect, it, vi } from 'vitest';
import { createRendererHarness } from '../helpers/renderer-harness';

const pendingOnboarding = {
  completedSteps: [] as Array<'prepare' | 'project' | 'ready' | 'welcome'>,
  currentStep: 'welcome' as const,
  flowVersion: 1,
  status: 'pending' as const,
};

describe('onboarding flow', () => {
  it('opens for a new profile, persists the selected path and moves in both directions', async () => {
    const updateOnboardingProgress = vi.fn(async (input) => ({
      ...input,
      flowVersion: 1,
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
      expect(harness.query('[data-onboarding-step="welcome"]').textContent).toContain(
        '先选一条最适合你的使用路径',
      );

      harness.click('[data-onboarding-path="codex"]');
      await harness.flush();
      expect(harness.query('#onboarding-welcome-next')).not.toHaveProperty('disabled', true);
      expect(updateOnboardingProgress).toHaveBeenCalledWith(
        expect.objectContaining({ currentStep: 'welcome', path: 'codex' }),
      );

      harness.click('#onboarding-welcome-next');
      await harness.flush();
      expect(harness.query('[data-onboarding-step="prepare"]').hidden).toBe(false);
      expect(harness.query('#onboarding-tool-status').textContent).toBe('项目后检测');

      harness.click('[data-onboarding-back="welcome"]');
      await harness.flush();
      expect(harness.query('[data-onboarding-step="welcome"]').hidden).toBe(false);
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
