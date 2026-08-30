import { describe, expect, it } from 'vitest';
import { settle, withRenderer } from '../helpers/renderer-interaction-fixture';

const HIGH_RISK_MESSAGE = '此为高危选项，未经完整检测或验证，谨慎选择';

describe('high-risk option tooltip', () => {
  it('exposes the warning to assistive technology and follows pointer/focus state', async () => {
    await withRenderer({}, async (harness) => {
      const codex = harness.query<HTMLInputElement>('#runtime-codex');
      const codexLabel = harness.query<HTMLElement>('[data-high-risk-target="runtime-codex"]');
      const nativeToggle = harness.query<HTMLButtonElement>('#native-terminal-toggle');
      const tooltip = harness.query<HTMLElement>('#high-risk-option-tooltip');

      expect(codex.getAttribute('aria-describedby')).toBe('high-risk-option-description');
      expect(nativeToggle.getAttribute('aria-describedby')).toBe('high-risk-option-description');
      expect(harness.query('#high-risk-option-description').textContent).toContain(
        HIGH_RISK_MESSAGE,
      );

      codexLabel.dispatchEvent(
        new harness.dom.window.MouseEvent('pointermove', {
          bubbles: true,
          clientX: 120,
          clientY: 160,
        }),
      );
      expect(tooltip.dataset.state).toBe('visible');
      expect(tooltip.getAttribute('aria-hidden')).toBe('false');
      expect(tooltip.textContent).toBe(HIGH_RISK_MESSAGE);
      await settle(harness);
      expect(tooltip.style.left).toBeTruthy();
      expect(tooltip.style.top).toBeTruthy();

      codex.focus();
      expect(tooltip.dataset.state).toBe('visible');
      harness.document.dispatchEvent(
        new harness.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
      expect(tooltip.dataset.state).toBe('hidden');
      expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('hides behind a modal dialog and restores an edge-safe placement after resize', async () => {
    await withRenderer({}, async (harness) => {
      const nativeToggle = harness.query<HTMLButtonElement>('#native-terminal-toggle');
      const tooltip = harness.query<HTMLElement>('#high-risk-option-tooltip');
      nativeToggle.dispatchEvent(
        new harness.dom.window.MouseEvent('pointerenter', {
          bubbles: true,
          clientX: 1000,
          clientY: 760,
        }),
      );
      await settle(harness);
      expect(tooltip.dataset.state).toBe('visible');

      const dialog = harness.query<HTMLDialogElement>('#confirmation-dialog');
      dialog.showModal();
      await settle(harness);
      expect(tooltip.dataset.state).toBe('hidden');
      dialog.close('cancel');

      nativeToggle.dispatchEvent(
        new harness.dom.window.MouseEvent('pointermove', {
          bubbles: true,
          clientX: 1000,
          clientY: 760,
        }),
      );
      await settle(harness);
      expect(tooltip.dataset.state).toBe('visible');
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('resize'));
      await settle(harness);
      expect(tooltip.style.left).toBeTruthy();
      expect(tooltip.style.top).toBeTruthy();
    });
  });
});
