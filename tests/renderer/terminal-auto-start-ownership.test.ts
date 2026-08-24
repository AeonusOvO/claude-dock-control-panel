import { describe, expect, it, vi } from 'vitest';
import type { ControlPanelApi } from '../../src/shared/contracts';
import { settle, withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { terminalStatus, terminalWorkspace } from '../helpers/renderer-terminal-fixture';

describe('automatic terminal start ownership', () => {
  it('keeps startup feedback owned through rerenders and rejects a duplicate click', async () => {
    const stopped = terminalStatus(1, { phase: 'stopped' });
    const running = terminalStatus(1);
    type StartResult = Awaited<ReturnType<ControlPanelApi['startTerminal']>>;
    let resolveStart: ((result: StartResult) => void) | undefined;
    const pendingStart = new Promise<StartResult>((resolve) => {
      resolveStart = resolve;
    });
    const startTerminal = vi.fn(() => pendingStart);

    await withTerminalRenderer(
      {
        getWorkspace: async () => terminalWorkspace(stopped),
        startTerminal,
      },
      async (harness) => {
        const toggle = harness.query<HTMLButtonElement>('#toggle-terminal');
        expect(harness.query('#toggle-terminal-label').textContent).toBe('正在启动…');
        expect(toggle.disabled).toBe(true);
        expect(toggle.getAttribute('aria-busy')).toBe('true');

        harness.emit('onWorkspaceState', terminalWorkspace(stopped));
        await harness.flush();
        expect(harness.query('#toggle-terminal-label').textContent).toBe('正在启动…');
        expect(toggle.disabled).toBe(true);
        expect(toggle.getAttribute('aria-busy')).toBe('true');
        harness.click('#toggle-terminal');
        expect(startTerminal).toHaveBeenCalledOnce();

        resolveStart?.({ ok: true, status: running });
        await settle(harness);
        expect(harness.query('#toggle-terminal-label').textContent).toBe('停止');
        expect(toggle.disabled).toBe(false);
        expect(toggle.getAttribute('aria-busy')).toBe('false');
      },
    );
  });

  it.each(['failure result', 'rejected IPC'] as const)(
    'does not retain composer focus intent after a %s',
    async (failureKind) => {
      const stopped = terminalStatus(1, { phase: 'stopped' });
      type StartResult = Awaited<ReturnType<ControlPanelApi['startTerminal']>>;
      const startTerminal = vi.fn((): Promise<StartResult> =>
        failureKind === 'failure result'
          ? Promise.resolve({ error: 'synthetic start failure', ok: false, status: stopped })
          : Promise.reject(new Error('synthetic start rejection')),
      );

      await withTerminalRenderer(
        {
          getWorkspace: async () => terminalWorkspace(stopped),
          startTerminal,
        },
        async (harness) => {
          const clear = harness.query<HTMLButtonElement>('#clear-terminal');
          clear.focus();
          expect(harness.document.activeElement).toBe(clear);

          harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
          await settle(harness);
          expect(harness.document.activeElement).toBe(clear);
        },
      );
    },
  );

  it('does not retain project-open focus intent after terminal spawn errors', async () => {
    const emptyWorkspace = { activeSessionId: '', projects: [], sessions: [] };
    const errored = terminalStatus(1, {
      diagnosticCode: 'PTY_START_FAILED',
      message: 'synthetic spawn failure',
      phase: 'error',
    });

    await withTerminalRenderer(
      {
        addProject: async () => ({ ok: true, state: terminalWorkspace(errored) }),
        getDroppedPath: () => errored.cwd,
        getWorkspace: async () => emptyWorkspace,
      },
      async (harness) => {
        const file = new harness.dom.window.File(['project'], 'project');
        const drop = new harness.dom.window.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
        harness.document.dispatchEvent(drop);
        await settle(harness);

        expect(harness.method('addProject')).toHaveBeenCalledWith(errored.cwd);
        expect(harness.document.body.dataset.phase).toBe('error');
        harness.click('#terminal-diagnostic-scrim');
        const clear = harness.query<HTMLButtonElement>('#clear-terminal');
        clear.focus();
        expect(harness.document.activeElement).toBe(clear);

        harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
        await settle(harness);
        expect(harness.document.activeElement).toBe(clear);
      },
    );
  });

  it('reconstructs startup presentation from a main-owned starting phase after reload', async () => {
    type StartResult = Awaited<ReturnType<ControlPanelApi['startTerminal']>>;
    const startTerminal = vi.fn(async (): Promise<StartResult> => ({
      ok: true,
      status: terminalStatus(2),
    }));
    await withTerminalRenderer(
      {
        getWorkspace: async () => terminalWorkspace(terminalStatus(1, { phase: 'starting' })),
        startTerminal,
      },
      async (harness) => {
        const toggle = harness.query<HTMLButtonElement>('#toggle-terminal');
        expect(harness.query('#toggle-terminal-label').textContent).toBe('正在启动…');
        expect(toggle.disabled).toBe(true);
        expect(toggle.getAttribute('aria-busy')).toBe('true');
        expect(startTerminal).not.toHaveBeenCalled();

        const clear = harness.query<HTMLButtonElement>('#clear-terminal');
        clear.focus();
        harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
        await settle(harness);
        expect(harness.document.activeElement).toBe(harness.query('#composer-input'));
      },
    );
  });

  it.each(['error', 'stopped', 'removed'] as const)(
    'clears reload focus intent when the starting session becomes %s',
    async (terminalOutcome) => {
      await withTerminalRenderer(
        {
          getWorkspace: async () => terminalWorkspace(terminalStatus(1, { phase: 'starting' })),
        },
        async (harness) => {
          harness.emit(
            'onWorkspaceState',
            terminalOutcome === 'removed'
              ? { activeSessionId: '', projects: [], sessions: [] }
              : terminalWorkspace(
                  terminalStatus(1, {
                    diagnosticCode: terminalOutcome === 'error' ? 'PTY_START_FAILED' : undefined,
                    message: terminalOutcome === 'error' ? 'synthetic spawn failure' : undefined,
                    phase: terminalOutcome,
                  }),
                ),
          );
          await settle(harness);
          if (terminalOutcome === 'error') {
            harness.click('#terminal-diagnostic-scrim');
          }

          const clear = harness.query<HTMLButtonElement>('#clear-terminal');
          clear.focus();
          expect(harness.document.activeElement).toBe(clear);

          harness.emit('onWorkspaceState', terminalWorkspace(terminalStatus(2)));
          await settle(harness);
          expect(harness.document.activeElement).toBe(clear);
        },
      );
    },
  );
});
