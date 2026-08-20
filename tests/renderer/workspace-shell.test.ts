import { describe, expect, it } from 'vitest';
import { expectCss, settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';

describe('remaining renderer behavior contracts', () => {
  it('exposes permanent history deletion with confirmation in every stored conversation row', async () => {
    await withTerminalRenderer(
      {
        getClaudeSessionsForPath: async () => [
          {
            conversationId: 'history-1',
            lastActiveAt: 1,
            messageCount: 2,
            sessionId: 'history-1',
            sessionName: 'Stored',
          },
        ],
      },
      async (harness) => {
        harness.click('[data-rail-tab="projects"]');
        harness.query<HTMLButtonElement>('.project-folder__disclosure').click();
        await settle(harness);
        const button = harness.query<HTMLButtonElement>('.history-item__delete');
        button.click();
        expect(harness.query('#confirmation-dialog').textContent).toContain('永久删除');
      },
    );
  });

  it('collapses an already-selected activity tab without losing the terminal', async () => {
    await withTerminalRenderer({}, async (harness) => {
      const terminal = harness.query('.project-terminal');
      harness.click('[data-rail-tab="projects"]');
      expect(harness.query('#workspace').classList.contains('workspace--rail-collapsed')).toBe(
        true,
      );
      expect(harness.query('.project-terminal')).toBe(terminal);
      expect(harness.query('#control-panel')).toHaveProperty('inert', true);
    });
  });

  it('locks the complete connection remedy surface and preserves the provider draft', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.click('[data-rail-tab="connection"]');
      harness.query<HTMLButtonElement>('[data-provider-id="anthropic"]').click();
      expect(harness.query<HTMLInputElement>('#claude-model').value).toBe('default');
      expect(harness.query('#connection-provider-picker')).not.toHaveProperty('inert', true);
    });
  });

  it('transitions the sidebar collapse and re-fits the terminal once it settles', async () => {
    await withTerminalRenderer({}, async (harness, control) => {
      harness.clearCalls();
      control.proposedDimensions = { cols: 120, rows: 40 };
      harness.query('#workspace').dispatchEvent(
        new harness.dom.window.TransitionEvent('transitionend', {
          bubbles: true,
          propertyName: 'grid-template-columns',
        }),
      );
      await settle(harness);
      expect(harness.method('resizeTerminal')).toHaveBeenCalled();
      expectCss(/body\.is-resizing \.workspace\s*\{\s*transition:\s*none/u);
    });
  });
});
