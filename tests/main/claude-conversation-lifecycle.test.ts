import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeConversationLifecycleCoordinator,
  runOwnedClaudeConversationDeletion,
} from '../../src/main/claude/conversation-lifecycle';

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

  it('waits for a cancelled resume but preserves the unrelated conversation still in that session', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const resumeGate = deferred();
    const events: string[] = [];
    const resume = coordinator.runResume(
      'D:\\Project Alpha',
      CONVERSATION_A,
      'session-running-b',
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
      isSessionInDirectory: () => true,
      readState: () => 'workspace-state',
      removePreferences: () => events.push('remove-preferences'),
      runWithSessionOwnership: async (sessionId, operation) => {
        events.push(`reserve:${sessionId}`);
        resumeGate.resolve();
        await resumeSettled;
        events.push(`unwound:${sessionId}`);
        operation();
      },
      sessionIdsForConversation: () => [],
      sessionOwnsConversation: () => false,
    });

    await resumeRejection;
    expect(result).toEqual({ deleted: true, state: 'workspace-state' });
    expect(events).toEqual([
      'reserve:session-running-b',
      'unwound:session-running-b',
      'delete-transcript',
      'remove-preferences',
    ]);
  });

  it('closes an exact active owner only while its replacement session lease is held', async () => {
    const coordinator = new ClaudeConversationLifecycleCoordinator();
    const events: string[] = [];
    let leaseHeld = false;

    const result = await runOwnedClaudeConversationDeletion({
      closeRuntimeSession: (sessionId) => {
        expect(leaseHeld).toBe(true);
        events.push(`close-runtime:${sessionId}`);
      },
      closeWorkspaceSession: (sessionId) => {
        expect(leaseHeld).toBe(true);
        events.push(`close-workspace:${sessionId}`);
      },
      conversationId: CONVERSATION_A,
      coordinator,
      cwd: 'D:\\Project Alpha',
      deleteTranscript: () => {
        events.push('delete-transcript');
        return true;
      },
      isSessionInDirectory: () => true,
      readState: () => ({ open: false }),
      removePreferences: vi.fn(),
      runWithSessionOwnership: async (sessionId, operation) => {
        events.push(`reserve:${sessionId}`);
        leaseHeld = true;
        try {
          operation();
        } finally {
          leaseHeld = false;
          events.push(`release:${sessionId}`);
        }
      },
      sessionIdsForConversation: () => ['runtime-owner'],
      sessionOwnsConversation: (sessionId) => sessionId === 'runtime-owner',
    });

    expect(result).toEqual({ deleted: true, state: { open: false } });
    expect(events).toEqual([
      'reserve:runtime-owner',
      'close-runtime:runtime-owner',
      'close-workspace:runtime-owner',
      'release:runtime-owner',
      'delete-transcript',
    ]);
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
        isSessionInDirectory: () => false,
        readState: () => 'unchanged',
        removePreferences,
        runWithSessionOwnership: async (_sessionId, operation) => operation(),
        sessionIdsForConversation: () => [],
        sessionOwnsConversation: () => false,
      }),
    ).resolves.toEqual({ deleted: false, state: 'unchanged' });
    expect(removePreferences).not.toHaveBeenCalled();
  });
});
