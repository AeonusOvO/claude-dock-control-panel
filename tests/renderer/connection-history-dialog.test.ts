import { describe, expect, it } from 'vitest';
import type { ClaudeConnectionHistoryEntry } from '../../src/shared/contracts';
import { withTerminalRenderer } from '../helpers/renderer-interaction-fixture';

const historyEntry = (
  id: string,
  preset: ClaudeConnectionHistoryEntry['preset'],
): ClaudeConnectionHistoryEntry => ({
  apiKeyHelperPolicy: 'inherit',
  authMode: preset === 'anthropic' ? 'existing' : 'authToken',
  baseUrl: preset === 'anthropic' ? '' : `https://${id}.example.test`,
  credentialConfigured: preset !== 'anthropic',
  gatewayState: 'unknown',
  id,
  model: `${id}-model`,
  preset,
  protocol: 'anthropic',
  provider: preset === 'anthropic' || preset === 'anthropic-api' ? 'anthropic' : 'gateway',
  savedAt: 1,
});

describe('connection history dialog', () => {
  it('groups the full history into four directional, keyboard-accessible tabs', async () => {
    const entries = [
      historyEntry('claude', 'anthropic'),
      historyEntry('chatgpt', 'chatgpt-subscription'),
      historyEntry('deepseek', 'deepseek'),
      historyEntry('glm', 'glm-cn'),
      historyEntry('relay', 'custom'),
    ];
    await withTerminalRenderer(
      { getClaudeConnectionHistory: async () => entries },
      async (harness) => {
        harness.click('#open-connection-history');
        await harness.flush();

        const dialog = harness.query<HTMLDialogElement>('#connection-history-dialog');
        expect(dialog.open).toBe(true);
        expect(harness.document.activeElement?.id).toBe('connection-history-tab-claude');
        expect(harness.query('[data-history-dialog-count="claude-subscription"]').textContent).toBe(
          '1 条',
        );
        expect(harness.query('[data-history-dialog-count="domestic"]').textContent).toBe('2 条');
        expect(harness.query('[data-history-dialog-count="api"]').textContent).toBe('1 条');
        expect(
          harness.document.querySelectorAll(
            '[data-history-dialog-list="domestic"] [data-history-id]',
          ),
        ).toHaveLength(2);

        harness.click('#connection-history-tab-domestic');
        expect(harness.query('#connection-history-dialog-track').style.transform).toBe(
          'translate3d(-200%, 0, 0)',
        );
        expect(
          harness.query('#connection-history-tab-domestic').getAttribute('aria-selected'),
        ).toBe('true');
        expect(harness.query('#connection-history-panel-domestic').hasAttribute('inert')).toBe(
          false,
        );
        expect(harness.query('#connection-history-panel-claude').hasAttribute('inert')).toBe(true);

        harness
          .query('#connection-history-tab-domestic')
          .dispatchEvent(
            new harness.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
          );
        expect(harness.document.activeElement?.id).toBe('connection-history-tab-api');
        expect(harness.query('#connection-history-dialog-track').style.transform).toBe(
          'translate3d(-300%, 0, 0)',
        );
      },
    );
  });

  it('keeps the history menu in the modal top layer and restores trigger focus on close', async () => {
    await withTerminalRenderer(
      { getClaudeConnectionHistory: async () => [historyEntry('claude', 'anthropic')] },
      async (harness) => {
        harness.click('#open-connection-history');
        await harness.flush();
        const dialog = harness.query<HTMLDialogElement>('#connection-history-dialog');
        const restore = harness.query(
          '[data-history-dialog-list="claude-subscription"] .connection-history__restore',
        );
        restore.dispatchEvent(
          new harness.dom.window.MouseEvent('contextmenu', {
            bubbles: true,
            clientX: 30,
            clientY: 40,
          }),
        );
        const menu = harness.query('#history-context-menu');
        expect(dialog.contains(menu)).toBe(true);
        expect(menu.hasAttribute('hidden')).toBe(false);

        harness.click('#finish-connection-history');
        await harness.flush();
        expect(dialog.open).toBe(false);
        expect(harness.document.body.contains(menu)).toBe(true);
        expect(harness.document.activeElement?.id).toBe('open-connection-history');
      },
    );
  });
});
