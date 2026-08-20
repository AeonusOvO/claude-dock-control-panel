import { describe, expect, it, vi } from 'vitest';
import { SessionGenerationRegistry } from '../../src/renderer/platform/session-generation';
import {
  expectCss,
  input,
  settle,
  withNativeRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import {
  claudeProjectState,
  nativeSnapshot,
  terminalStatus,
  terminalWorkspace,
} from '../helpers/renderer-terminal-fixture';

describe('native conversation behavior', () => {
  it('keeps explicit questions usable in strict mode and restores the gated bypass option', async () => {
    const snapshot = nativeSnapshot({
      interactions: [
        { createdAt: 1, id: 'q1', kind: 'question', questions: [], title: 'Choose explicitly' },
      ],
      phase: 'requires-action',
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      expect(harness.query('#native-interaction-stack').textContent).toContain('Choose explicitly');
      harness.click('#footer-mode');
      expect(harness.query('#footer-mode-menu').textContent).toContain('完全允许');
      expect(harness.query('#footer-mode-menu').textContent).toContain('仅预批准');
    });
  });

  it('keeps the primary launch action visible through remediable route failures', async () => {
    await withTerminalRenderer({}, async (harness) => {
      harness.emit(
        'onClaudeState',
        claudeProjectState({
          routeHealth: {
            blocking: true,
            checkedAt: 1,
            detail: 'Start router',
            headline: 'Route unavailable',
            source: 'router',
            tone: 'error',
          },
        }),
      );
      const button = harness.query<HTMLButtonElement>('#run-claude');
      expect(button.hidden).toBe(false);
      expect(button.disabled).toBe(false);
      expect(button.dataset.launchBlocked).toBe('true');
    });
  });

  it('routes every primary Claude session action through the safe terminal', async () => {
    await withTerminalRenderer(
      { launchClaude: async () => ({ ok: true, state: claudeProjectState({ active: true }) }) },
      async (harness) => {
        harness.click('#run-claude');
        await harness.flush();
        expect(harness.method('launchClaude')).toHaveBeenCalledWith('session-1', 'new');
        expect(harness.method('startNativeConversation')).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps native conversation behind an explicit toolbar action', async () => {
    await withTerminalRenderer(
      {
        adoptTerminalConversation: async () => ({
          conversationId: 'conversation-1',
          ok: true,
          snapshot: nativeSnapshot(),
        }),
      },
      async (harness) => {
        expect(harness.query('#native-conversation').dataset.state).toBe('closed');
        harness.click('#native-terminal-toggle');
        await settle(harness);
        expect(harness.method('adoptTerminalConversation')).toHaveBeenCalledWith(
          'session-1',
          false,
        );
        expect(harness.query('#native-conversation').dataset.state).toMatch(/opening|open/u);
      },
    );
  });

  it('always leaves the startup status after a native launch failure', async () => {
    const stopped = terminalStatus(1, { phase: 'stopped' });
    await withTerminalRenderer(
      {
        getClaudeProjectState: async () =>
          claudeProjectState({
            active: false,
            config: {
              ...claudeProjectState().config,
              credentialConfigured: true,
            },
            ptyGeneration: 1,
          }),
        getWorkspace: async () => terminalWorkspace(stopped),
        startNativeConversation: async () => {
          throw new Error('synthetic failure');
        },
      },
      async (harness) => {
        harness.click('#native-terminal-toggle');
        await settle(harness);
        expect(harness.query('#native-composer-status').textContent).not.toBe(
          '正在安全启动 Claude…',
        );
        expect(harness.query('#native-composer-status').textContent).toContain('启动失败');
      },
    );
  });

  it('keeps native launch buttons busy only for the owned project startup', () => {
    const registry = new SessionGenerationRegistry();
    const owned = registry.begin('session-1');
    expect(registry.isActive('session-1')).toBe(true);
    expect(registry.isActive('session-2')).toBe(false);
    expect(registry.finish(owned)).toBe(true);
  });

  it('generation-scopes native submission acknowledgement and never drops composer content', async () => {
    const submit = vi.fn(async () => {
      throw new Error('synthetic rejection');
    });
    await withNativeRenderer(
      nativeSnapshot(),
      { submitNativeConversation: submit },
      async (harness) => {
        input(harness.query('#native-composer-input'), 'keep me');
        harness.query<HTMLFormElement>('#native-composer').requestSubmit();
        await settle(harness);
        expect(submit).toHaveBeenCalled();
        expect(harness.query('#native-queued').textContent).toContain('keep me');
      },
    );
  });

  it('keeps user prompts as bubbles and streams each assistant turn through one terminal shell', async () => {
    const snapshot = nativeSnapshot({
      messages: [
        {
          blocks: [{ id: 'u1', text: 'Hello', type: 'text' }],
          createdAt: 1,
          id: 'user-1',
          role: 'user',
          status: 'complete',
        },
        {
          blocks: [{ id: 'a1', text: 'Working', type: 'text' }],
          createdAt: 2,
          id: 'assistant-1',
          role: 'assistant',
          status: 'streaming',
        },
      ],
      phase: 'running',
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      expect(harness.document.querySelectorAll('.native-message--user')).toHaveLength(1);
      expect(harness.document.querySelectorAll('.native-message--assistant')).toHaveLength(1);
      const assistant = harness.query('.native-message--assistant');
      harness.emit(
        'onNativeConversation',
        nativeSnapshot({ ...snapshot, revision: 2, sequence: 2 }),
      );
      await settle(harness);
      expect(harness.query('.native-message--assistant')).toBe(assistant);
    });
  });

  it('gives the native composer exactly one action button that hands over to stop', async () => {
    await withNativeRenderer(nativeSnapshot({ phase: 'running' }), {}, async (harness) => {
      expect(harness.document.querySelectorAll('#native-send')).toHaveLength(1);
      expect(harness.document.querySelector('#native-stop')).toBeNull();
      expect(harness.query('#native-send').getAttribute('data-action')).toBe('stop');
      input(harness.query('#native-composer-input'), 'next');
      expect(harness.query('#native-send').getAttribute('data-action')).toBe('send');
    });
  });

  it('keeps the status footer mounted and native-aware while a native conversation is open', async () => {
    await withNativeRenderer(nativeSnapshot(), {}, async (harness) => {
      const footer = harness.query('.terminal-footer');
      harness.emit(
        'onClaudeState',
        claudeProjectState({ metrics: { capturedAt: 1, modelDisplayName: 'stale' } }),
      );
      expect(harness.query('.terminal-footer')).toBe(footer);
      expect(harness.query('#footer-model').textContent).toContain('Claude Sonnet 5');
    });
  });

  it('renders the interaction queue one item at a time', async () => {
    const snapshot = nativeSnapshot({
      interactions: [
        { createdAt: 1, id: 'q1', kind: 'question', questions: [], title: 'First' },
        { createdAt: 2, id: 'q2', kind: 'question', questions: [], title: 'Second' },
      ],
      phase: 'requires-action',
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      const stack = harness.query('#native-interaction-stack');
      expect(stack.dataset.pendingCount).toBe('2');
      expect(stack.querySelectorAll('.native-interaction')).toHaveLength(1);
      expect(stack.textContent).toContain('First');
      expect(stack.textContent).not.toContain('Second');
    });
  });

  it('keeps summary actions inside the shared button component suite', async () => {
    const snapshot = nativeSnapshot({
      tasks: [
        {
          cancellable: true,
          description: 'Running task',
          id: 'task-1',
          kind: 'subagent',
          status: 'running',
          updatedAt: 1,
        },
      ],
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      harness.click('#runtime-activity-trigger');
      const action = harness.query('.runtime-summary-row__action');
      expect(Array.from(action.classList)).toEqual(
        expect.arrayContaining(['button', 'button--compact', 'button--quiet']),
      );
    });
  });

  it('places compact, semantically colored status tags beside task titles', async () => {
    const snapshot = nativeSnapshot({
      tasks: [
        {
          cancellable: false,
          description: 'Waiting task',
          id: 'task-1',
          kind: 'workflow',
          status: 'waiting',
          updatedAt: 1,
        },
      ],
    });
    await withNativeRenderer(snapshot, {}, async (harness) => {
      harness.click('#runtime-activity-trigger');
      const row = harness.query('.runtime-summary-row[data-status="waiting"]');
      expect(
        row.querySelector('.runtime-summary-row__title .runtime-summary-row__tag'),
      ).not.toBeNull();
      expectCss(/\[data-status='waiting'\] \.runtime-summary-row__tag/u);
    });
  });
});
