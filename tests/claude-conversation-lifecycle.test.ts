import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeConversationLifecycleCoordinator,
  runOwnedClaudeConversationDeletion,
} from '../src/main/claude-conversation-lifecycle';

const CONVERSATION_A = '8f9aa605-adb6-4e2b-a25a-607e14bad666';
const CONVERSATION_B = '53b9f42a-a26a-4ce6-a6d3-82d783c8bdde';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('ClaudeConversationLifecycleCoordinator', () => {
  it('cancels an older exact resume and blocks replacements until deletion commits', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const resumeGate = deferred();
    const deleteGate = deferred();
    const resume = coordinator.runResume(
      'D:\\Project Alpha',
      CONVERSATION_A,
      'session-1',
      async (ownership) => {
        await resumeGate.promise;
        ownership.assertCurrent();
      },
    );
    const resumeRejection = expect(resume).rejects.toThrow(/永久删除/);
    let pendingResumeSessionIds: string[] = [];
    const deletion = coordinator.runDeletion(
      'd:\\project alpha',
      CONVERSATION_A,
      async (ownership) => {
        pendingResumeSessionIds = ownership.pendingResumeSessionIds();
        await deleteGate.promise;
        ownership.assertCurrent();
        return 'deleted';
      },
    );

    expect(pendingResumeSessionIds).toEqual(['session-1']);
    expect(() =>
      coordinator.runResume(
        'D:\\Project Alpha',
        CONVERSATION_A,
        'session-2',
        async () => undefined,
      ),
    ).toThrow(/正在永久删除/);

    resumeGate.resolve();
    await resumeRejection;
    deleteGate.resolve();
    await expect(deletion).resolves.toBe('deleted');
    await expect(
      coordinator.runResume('D:\\Project Alpha', CONVERSATION_A, 'session-3', async (ownership) => {
        ownership.assertCurrent();
        return 'resumed';
      }),
    ).resolves.toBe('resumed');
  });

  it('treats an ambiguous continue as matching every deletion in its project', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const resumeGate = deferred();
    const resume = coordinator.runResume(
      'D:\\Project Alpha',
      undefined,
      'session-1',
      async (ownership) => {
        await resumeGate.promise;
        ownership.assertCurrent();
      },
    );
    const resumeRejection = expect(resume).rejects.toThrow(/永久删除/);

    await coordinator.runDeletion('D:\\Project Alpha', CONVERSATION_A, async (ownership) => {
      expect(ownership.pendingResumeSessionIds()).toEqual(['session-1']);
    });
    resumeGate.resolve();

    await resumeRejection;
  });

  it('keeps an exact resume of another conversation independent', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const otherResumeGate = deferred();
    const otherResume = coordinator.runResume(
      'D:\\Project Alpha',
      CONVERSATION_B,
      'session-2',
      async (ownership) => {
        await otherResumeGate.promise;
        ownership.assertCurrent();
        return 'other';
      },
    );

    await coordinator.runDeletion('D:\\Project Alpha', CONVERSATION_A, async (ownership) => {
      expect(ownership.pendingResumeSessionIds()).toEqual([]);
      coordinator.assertLaunchAllowed('D:\\Project Alpha', 'resume', CONVERSATION_B);
      expect(() => coordinator.assertLaunchAllowed('D:\\Project Alpha', 'continue')).toThrow(
        /正在永久删除/,
      );
      coordinator.assertLaunchAllowed('D:\\Project Alpha', 'new');
    });
    otherResumeGate.resolve();

    await expect(otherResume).resolves.toBe('other');
  });

  it('waits for a cancelled resume to unwind before unlinking its transcript', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const resumeGate = deferred();
    const events: string[] = [];
    const resume = coordinator.runResume(
      'D:\\Project Alpha',
      CONVERSATION_A,
      'pending-resume',
      async (ownership) => {
        await resumeGate.promise;
        ownership.assertCurrent();
      },
    );
    const resumeRejection = expect(resume).rejects.toThrow(/永久删除/);
    const resumeSettled = resume.catch(() => undefined);

    const result = await runOwnedClaudeConversationDeletion({
      closeRuntimeSession: (sessionId) => events.push(`close-runtime:${sessionId}`),
      closeWorkspaceSession: (sessionId) => events.push(`close-workspace:${sessionId}`),
      conversationId: CONVERSATION_A,
      coordinator,
      cwd: 'd:\\project alpha',
      deleteTranscript: () => {
        events.push('delete-transcript');
        return true;
      },
      invalidateAndWait: async (sessionId) => {
        events.push(`invalidate:${sessionId}`);
        resumeGate.resolve();
        await resumeSettled;
        events.push(`unwound:${sessionId}`);
      },
      isSessionInDirectory: () => true,
      readState: () => 'workspace-state',
      removePreferences: () => events.push('remove-preferences'),
      sessionIdsForConversation: () => [],
    });

    await resumeRejection;
    expect(result).toEqual({ deleted: true, state: 'workspace-state' });
    expect(events).toEqual([
      'invalidate:pending-resume',
      'unwound:pending-resume',
      'close-runtime:pending-resume',
      'close-workspace:pending-resume',
      'delete-transcript',
      'remove-preferences',
    ]);
  });

  it('re-snapshots owners that bind while cancellation is unwinding', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    let runtimeSessionIds = ['runtime-owner'];
    const invalidated: string[] = [];
    const closedRuntime: string[] = [];
    const closedWorkspace: string[] = [];

    const result = await runOwnedClaudeConversationDeletion({
      closeRuntimeSession: (sessionId) => closedRuntime.push(sessionId),
      closeWorkspaceSession: (sessionId) => closedWorkspace.push(sessionId),
      conversationId: CONVERSATION_A,
      coordinator,
      cwd: 'D:\\Project Alpha',
      deleteTranscript: () => {
        expect(() =>
          coordinator.runResume(
            'D:\\Project Alpha',
            CONVERSATION_A,
            'replacement-resume',
            async () => undefined,
          ),
        ).toThrow(/正在永久删除/);
        return true;
      },
      invalidateAndWait: async (sessionId) => {
        invalidated.push(sessionId);
        if (sessionId === 'runtime-owner') {
          runtimeSessionIds = ['runtime-owner', 'late-bound-owner'];
        }
      },
      isSessionInDirectory: () => true,
      readState: () => ({ open: false }),
      removePreferences: vi.fn(),
      sessionIdsForConversation: () => runtimeSessionIds,
    });

    expect(result).toEqual({ deleted: true, state: { open: false } });
    expect(invalidated).toEqual(['runtime-owner', 'late-bound-owner']);
    expect(closedRuntime).toEqual(['runtime-owner', 'late-bound-owner']);
    expect(closedWorkspace).toEqual(['runtime-owner', 'late-bound-owner']);
  });

  it('preserves conversation preferences when transcript deletion fails', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const removePreferences = vi.fn();

    await expect(
      runOwnedClaudeConversationDeletion({
        closeRuntimeSession: vi.fn(),
        closeWorkspaceSession: vi.fn(),
        conversationId: CONVERSATION_A,
        coordinator,
        cwd: 'D:\\Project Alpha',
        deleteTranscript: () => false,
        invalidateAndWait: async () => undefined,
        isSessionInDirectory: () => false,
        readState: () => 'unchanged',
        removePreferences,
        sessionIdsForConversation: () => [],
      }),
    ).resolves.toEqual({ deleted: false, state: 'unchanged' });
    expect(removePreferences).not.toHaveBeenCalled();
  });
});
