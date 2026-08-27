import { describe, expect, it, vi } from 'vitest';
import { createRunClaudeProjectConfigTransaction } from '../../src/main/claude/project-config-transaction';
import { SessionConfigTransactionCoordinator } from '../../src/main/coordination/main-process-operation';
import type { ClaudeProjectState } from '../../src/shared/contracts';

describe('Claude project config transaction target ownership', () => {
  it('isolates two same-folder conversation profiles and rolls back only the failing one', async () => {
    const scopes = new Map([
      ['session-1', 'D:\\Profiles\\one'],
      ['session-2', 'D:\\Profiles\\two'],
    ]);
    const profiles = new Map([...scopes.values()].map((scope) => [scope, 'original']));
    let failFirst!: () => void;
    const firstCompletion = new Promise<ClaudeProjectState>((_resolve, reject) => {
      failFirst = () => reject(new Error('first completion failed'));
    });
    const runtime = {
      connectionConfigScope: (id: string) => scopes.get(id)!,
      createConfigSnapshot: (scope: string) => profiles.get(scope),
      getState: vi.fn(async () => ({})),
      mergeConfigCompletionSnapshot: (committed: string) => committed,
      restoreConfigSnapshot: (scope: string, saved: string) => profiles.set(scope, saved),
      rollbackPreparedConfig: vi.fn(async () => undefined),
    };
    const managedConfigTransactions = new SessionConfigTransactionCoordinator();
    const isolateDirectory = vi.fn(async () => undefined);
    const run = createRunClaudeProjectConfigTransaction({
      acquireConfigTransactionIsolation: isolateDirectory,
      guards: { assertExternalRoutingWritesAllowed: vi.fn() },
      managedConfigTransactions,
      publishRestoredClaudeProjectState: vi.fn(),
      workspace: { getStatus: (id: string) => ({ cwd: 'D:\\Project', id }) } as never,
    });
    const options = (sessionId: string) => ({
      assertCurrent: vi.fn(),
      commit: () => {
        profiles.set(scopes.get(sessionId)!, sessionId);
      },
      complete: vi.fn(async () =>
        sessionId === 'session-1' ? firstCompletion : ({} as ClaudeProjectState),
      ),
      cwd: 'D:\\Project',
      prepare: () => sessionId,
      runtime: runtime as never,
      sessionId,
    });
    const firstOptions = options('session-1');
    const first = run(firstOptions).catch((error: unknown) => error);
    await vi.waitFor(() => expect(firstOptions.complete).toHaveBeenCalledOnce());
    const secondOptions = options('session-2');
    const second = run(secondOptions);
    await vi.waitFor(() => expect(secondOptions.complete).toHaveBeenCalledOnce());
    await second;
    expect(() =>
      managedConfigTransactions.assertDevelopmentOperationAllowed('D:\\Project', 'new-session'),
    ).not.toThrow();
    failFirst();
    await first;
    expect(profiles.get(scopes.get('session-1')!)).toBe('original');
    expect(profiles.get(scopes.get('session-2')!)).toBe('session-2');
    expect(isolateDirectory).not.toHaveBeenCalled();
  });

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
