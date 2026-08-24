import { describe, expect, it } from 'vitest';
import {
  ClaudeLaunchAttemptRegistry,
  orchestrateClaudeLaunchAttempt,
} from '../../src/renderer/platform/claude-launch-attempt';
import type { TerminalStatus } from '../../src/shared/contracts';

const terminal = (
  id: string,
  phase: TerminalStatus['phase'],
  pid?: number,
  ptyGeneration = 1,
): TerminalStatus => ({
  cwd: `C:\\projects\\${id}`,
  id,
  phase,
  pid,
  ptyGeneration,
  shell: 'powershell.exe',
  title: id,
});

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let reject = (_reason?: unknown): void => undefined;
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

const tombstoneCount = (registry: ClaudeLaunchAttemptRegistry): number => {
  const tombstones: unknown = Reflect.get(registry, 'resultTombstones');
  if (!(tombstones instanceof Map)) {
    throw new Error('Claude result tombstones are not retained in a map.');
  }
  return tombstones.size;
};

type AttemptInvalidator = (registry: ClaudeLaunchAttemptRegistry) => void;

const attemptInvalidations: ReadonlyArray<readonly [string, AttemptInvalidator]> = [
  [
    'session deletion',
    (registry) => {
      registry.prune(new Set());
    },
  ],
  [
    'terminal failure',
    (registry) => {
      registry.observeTerminal(terminal('session-a', 'error', undefined, 2));
    },
  ],
  [
    'explicit invalidation',
    (registry) => {
      registry.invalidate('session-a');
    },
  ],
];

describe('Claude launch attempts', () => {
  it('locks a cold session synchronously and keeps other sessions independent', () => {
    const registry = new ClaudeLaunchAttemptRegistry();

    registry.begin('session-a', {});

    expect(registry.isBusy('session-a')).toBe(true);
    expect(registry.isBusy('session-b')).toBe(false);
    expect(() => registry.begin('session-a', {})).toThrow('正在启动');
    expect(() => registry.begin('session-b', {})).not.toThrow();
  });

  it('keeps preflight, starting and paused presentation phases under the exact attempt', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const first = registry.begin('session-a', {
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(registry.presentationPhase('session-a')).toBe('preflight');
    expect(
      registry.observeTerminal(terminal('session-a', 'starting', undefined, 2)),
    ).toBeUndefined();
    expect(registry.presentationPhase('session-a')).toBe('starting');
    expect(registry.setPresentationPhase(first, 'paused')).toBe(true);
    expect(registry.presentationPhase('session-a')).toBe('paused');

    registry.invalidate('session-a');
    const replacement = registry.begin('session-a', {});
    expect(registry.setPresentationPhase(first, 'starting')).toBe(false);
    expect(registry.presentationPhase('session-a')).toBe('preflight');
    expect(registry.isCurrent(replacement)).toBe(true);
  });

  it('releases when an accepted result is followed by a different conversation UUID', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const token = registry.begin('session-a', {
      active: false,
      conversationId: 'conversation-old',
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(registry.acceptResult(token, 'success')).toBe(true);
    expect(
      registry.observeClaude({
        active: true,
        conversationId: 'conversation-new',
        sessionId: 'session-a',
      }),
    ).toMatchObject({ reason: 'conversation' });
    expect(registry.isBusy('session-a')).toBe(false);
  });

  it('hydrates an unknown conversation baseline before accepting a later UUID as new', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const token = registry.begin('session-a', {
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(
      registry.observeClaude({
        active: true,
        conversationId: 'conversation-existing',
        sessionId: 'session-a',
      }),
    ).toBeUndefined();
    expect(registry.isBusy('session-a')).toBe(true);
    expect(registry.acceptResult(token, 'success')).toBe(true);
    expect(
      registry.observeClaude({
        active: true,
        conversationId: 'conversation-new',
        sessionId: 'session-a',
      })?.reason,
    ).toBe('conversation');
  });

  it('releases when an accepted result is followed by a new running PowerShell PID', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    registry.observeTerminal(terminal('session-a', 'running', 10));
    const token = registry.begin('session-a', {
      active: false,
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(
      registry.observeTerminal(terminal('session-a', 'starting', undefined, 2)),
    ).toBeUndefined();
    expect(registry.acceptResult(token, 'success')).toBe(true);
    expect(registry.observeTerminal(terminal('session-a', 'running', 11, 2))?.reason).toBe(
      'powershell',
    );
    expect(registry.isBusy('session-a')).toBe(false);
  });

  it('releases for an accepted result when Windows reuses the PID on a new PTY generation', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    registry.observeTerminal(terminal('session-a', 'running', 10, 1));
    const token = registry.begin('session-a', {
      active: false,
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(
      registry.observeTerminal(terminal('session-a', 'starting', undefined, 2)),
    ).toBeUndefined();
    expect(registry.acceptResult(token, 'success')).toBe(true);
    expect(registry.observeTerminal(terminal('session-a', 'running', 10, 2))?.reason).toBe(
      'powershell',
    );
    expect(registry.isBusy('session-a')).toBe(false);
  });

  it.each(['success', 'failure'] as const)(
    'retains early replacement evidence until the %s result is accepted',
    (disposition) => {
      const registry = new ClaudeLaunchAttemptRegistry();
      const token = registry.begin('session-a', {
        active: false,
        terminalPhase: 'running',
        terminalPid: 10,
        terminalPtyGeneration: 1,
      });

      expect(registry.observeTerminal(terminal('session-a', 'running', 11, 2))).toBeUndefined();
      expect(registry.isCurrent(token)).toBe(true);
      expect(registry.isBusy('session-a')).toBe(true);

      expect(registry.acceptResult(token, disposition)).toBe(true);
      expect(registry.isBusy('session-a')).toBe(false);
    },
  );

  it('releases when Claude exits and the same PowerShell remains running', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    registry.observeTerminal(terminal('session-a', 'running', 10));
    const token = registry.begin('session-a', {
      active: false,
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(registry.observeClaude({ active: true, sessionId: 'session-a' })).toBeUndefined();
    expect(registry.acceptResult(token, 'success')).toBe(true);
    expect(registry.observeClaude({ active: false, sessionId: 'session-a' })?.reason).toBe(
      'claude-exit',
    );
  });

  it.each(['error', 'stopped'] as const)('releases on an explicit terminal %s state', (phase) => {
    const registry = new ClaudeLaunchAttemptRegistry();
    registry.begin('session-a', {
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });

    expect(registry.observeTerminal(terminal('session-a', phase))?.reason).toBe('terminal-failure');
  });

  it('does not let stale failures or hydration update a newer generation', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const first = registry.begin('session-a', {});
    registry.invalidate('session-a');
    const second = registry.begin('session-a', {});

    expect(registry.fail(first)).toBeUndefined();
    expect(
      registry.hydrateClaude(first, {
        active: true,
        conversationId: 'conversation-stale',
        sessionId: 'session-a',
      }),
    ).toBe(false);
    expect(registry.isCurrent(second)).toBe(true);
    expect(registry.isBusy('session-a')).toBe(true);
  });

  it('does not apply an old settlement with retained running evidence to a newer attempt', async () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const ipc = deferred<string>();
    const first = registry.begin('session-a', {
      terminalPhase: 'running',
      terminalPid: 10,
      terminalPtyGeneration: 1,
    });
    const applied: string[] = [];
    const completion = orchestrateClaudeLaunchAttempt({
      applyResult: (result) => {
        applied.push(result);
        return registry.acceptResult(first, 'success');
      },
      registry,
      start: () => ipc.promise,
      token: first,
    });

    expect(registry.observeTerminal(terminal('session-a', 'running', 11, 2))).toBeUndefined();
    registry.invalidate('session-a');
    const replacement = registry.begin('session-a', {
      terminalPhase: 'running',
      terminalPid: 11,
      terminalPtyGeneration: 2,
    });
    ipc.resolve('old result');

    await expect(completion).resolves.toEqual({ status: 'stale' });
    expect(applied).toEqual([]);
    expect(registry.isCurrent(replacement)).toBe(true);
    expect(registry.isBusy('session-a')).toBe(true);
  });

  it.each(attemptInvalidations)(
    'does not start stale IPC or mutate a replacement after %s resolves an old confirmation',
    async (_label, invalidate) => {
      const registry = new ClaudeLaunchAttemptRegistry();
      const confirmation = deferred<boolean>();
      const first = registry.begin('session-a', {});
      const applied: string[] = [];
      const releases: string[] = [];
      const toasts: string[] = [];
      let starts = 0;
      const completion = orchestrateClaudeLaunchAttempt({
        applyResult: (result) => {
          applied.push(result);
          return registry.acceptResult(first, 'success');
        },
        confirmation: () => confirmation.promise,
        onRelease: (release) => {
          releases.push(release.reason);
        },
        registry,
        start: async () => {
          starts += 1;
          return 'stale result';
        },
        token: first,
      }).then((outcome) => {
        if (outcome.status === 'rejected') {
          toasts.push('stale rejection');
        }
        return outcome;
      });

      invalidate(registry);
      const replacement = registry.begin('session-a', {});
      confirmation.resolve(true);

      await expect(completion).resolves.toEqual({ status: 'stale' });
      expect(starts).toBe(0);
      expect(applied).toEqual([]);
      expect(releases).toEqual([]);
      expect(toasts).toEqual([]);
      expect(registry.isCurrent(replacement)).toBe(true);
      expect(registry.isBusy('session-a')).toBe(true);
    },
  );

  it.each(attemptInvalidations)(
    'does not report or release a replacement when old IPC rejects after %s',
    async (_label, invalidate) => {
      const registry = new ClaudeLaunchAttemptRegistry();
      const confirmation = deferred<boolean>();
      const ipc = deferred<string>();
      const started = deferred<void>();
      const first = registry.begin('session-a', {});
      const applied: string[] = [];
      const releases: string[] = [];
      const toasts: string[] = [];
      let starts = 0;
      const completion = orchestrateClaudeLaunchAttempt({
        applyResult: (result) => {
          applied.push(result);
          return registry.acceptResult(first, 'success');
        },
        confirmation: () => confirmation.promise,
        onRelease: (release) => {
          releases.push(release.reason);
        },
        registry,
        start: () => {
          starts += 1;
          started.resolve();
          return ipc.promise;
        },
        token: first,
      }).then((outcome) => {
        if (outcome.status === 'rejected') {
          toasts.push('old IPC failed');
        }
        return outcome;
      });

      confirmation.resolve(true);
      await started.promise;
      expect(starts).toBe(1);
      invalidate(registry);
      const replacement = registry.begin('session-a', {});
      ipc.reject(new Error('late rejection'));

      await expect(completion).resolves.toEqual({ status: 'stale' });
      expect(applied).toEqual([]);
      expect(releases).toEqual([]);
      expect(toasts).toEqual([]);
      expect(registry.isCurrent(replacement)).toBe(true);
      expect(registry.isBusy('session-a')).toBe(true);
    },
  );

  it('tombstones an explicit result so it can apply only once', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const token = registry.begin('session-a', {});

    expect(registry.acceptResult(token, 'success')).toBe(true);
    expect(registry.acceptResult(token, 'failure')).toBe(false);
    expect(registry.isCurrent(token)).toBe(true);
  });

  it('bounds result tombstones to sessions that still exist', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const retainedSessionId = 'session-255';
    for (let index = 0; index < 256; index += 1) {
      const sessionId = `session-${index}`;
      const token = registry.begin(sessionId, {});
      expect(registry.acceptResult(token, 'success')).toBe(true);
    }

    expect(tombstoneCount(registry)).toBe(256);
    registry.prune(new Set([retainedSessionId]));
    expect(tombstoneCount(registry)).toBe(1);
    registry.prune(new Set());
    expect(tombstoneCount(registry)).toBe(0);
  });

  it('drops a deferred result after its generation is replaced', async () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const oldResult = deferred<string>();
    const first = registry.begin('session-a', {});
    const applied: string[] = [];
    const completion = oldResult.promise.then((value) => {
      if (registry.acceptResult(first, 'success')) {
        applied.push(value);
      }
    });

    registry.invalidate('session-a');
    const replacement = registry.begin('session-a', {});
    oldResult.resolve('stale state');
    await completion;

    expect(applied).toEqual([]);
    expect(registry.isCurrent(replacement)).toBe(true);
  });

  it('releases only the exact generation on cancellation or explicit failure', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    const cancelled = registry.begin('session-a', {});

    expect(registry.cancel(cancelled)?.reason).toBe('cancelled');
    const failed = registry.begin('session-a', {});
    expect(registry.fail(failed)?.reason).toBe('explicit-failure');
    expect(registry.isBusy('session-a')).toBe(false);
  });

  it('prunes deleted sessions without disturbing live attempts', () => {
    const registry = new ClaudeLaunchAttemptRegistry();
    registry.begin('session-a', {});
    registry.begin('session-b', {});

    expect(registry.prune(new Set(['session-b']))).toMatchObject([
      { reason: 'session-deleted', token: { sessionId: 'session-a' } },
    ]);
    expect(registry.isBusy('session-a')).toBe(false);
    expect(registry.isBusy('session-b')).toBe(true);
  });
});
