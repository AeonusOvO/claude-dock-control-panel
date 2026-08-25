import { describe, expect, it, vi } from 'vitest';
import { createRunClaudeProjectConfigTransaction } from '../../src/main/claude/project-config-transaction';
import { SessionConfigTransactionCoordinator } from '../../src/main/coordination/main-process-operation';

describe('Claude project config transaction target ownership', () => {
  it('does not rebind runtime state to an old directory after the session changes projects', async () => {
    const status = { cwd: 'D:\\ProjectA', id: 'session-1' };
    const runtime = {
      createConfigSnapshot: vi.fn(() => ({ config: 'original' })),
      getState: vi.fn(),
      mergeConfigCompletionSnapshot: vi.fn((committed) => committed),
      restoreConfigSnapshot: vi.fn(),
      rollbackPreparedConfig: vi.fn(async () => undefined),
    };
    const runClaudeProjectConfigTransaction = createRunClaudeProjectConfigTransaction({
      acquireConfigTransactionIsolation: vi.fn(async () => undefined),
      guards: { assertExternalRoutingWritesAllowed: vi.fn() },
      managedConfigTransactions: new SessionConfigTransactionCoordinator(),
      publishRestoredClaudeProjectState: vi.fn(),
      workspace: { getStatus: vi.fn(() => status) } as never,
    });

    const execution = runClaudeProjectConfigTransaction({
      assertCurrent: vi.fn(),
      commit: vi.fn(),
      complete: vi.fn(),
      cwd: 'D:\\ProjectA',
      prepare: () => {
        status.cwd = 'D:\\ProjectB';
        return { route: 'prepared' };
      },
      runtime: runtime as never,
      sessionId: 'session-1',
    });

    await expect(execution).rejects.toMatchObject({ state: undefined });
    expect(runtime.rollbackPreparedConfig).toHaveBeenCalledOnce();
    expect(runtime.getState).not.toHaveBeenCalled();
  });
});
