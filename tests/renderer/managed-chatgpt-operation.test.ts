import { describe, expect, it, vi } from 'vitest';
import {
  ManagedChatGptOperationTracker,
  runManagedChatGptOperation,
} from '../../src/renderer/features/connection/managed-chatgpt-operation';

describe('ManagedChatGptOperationTracker', () => {
  it('acquires and releases the global operation scope', () => {
    const tracker = new ManagedChatGptOperationTracker();

    expect(tracker.busy).toBe(false);
    expect(tracker.begin()).toBe(true);
    expect(tracker.busy).toBe(true);

    tracker.finish();
    expect(tracker.busy).toBe(false);
  });

  it('acquires and releases a session-scoped operation', () => {
    const tracker = new ManagedChatGptOperationTracker();

    expect(tracker.begin('session-a')).toBe(true);
    expect(tracker.busy).toBe(true);

    tracker.finish('session-a');
    expect(tracker.busy).toBe(false);
  });

  it('coalesces repeated clicks while either a global or session operation is active', () => {
    const tracker = new ManagedChatGptOperationTracker();

    expect(tracker.begin('session-a')).toBe(true);
    expect(tracker.begin('session-a')).toBe(false);
    expect(tracker.begin('session-b')).toBe(false);
    expect(tracker.begin()).toBe(false);
    expect(tracker.busy).toBe(true);

    tracker.finish('session-a');
    expect(tracker.begin()).toBe(true);
  });

  it('clears completion from the source session after the user switches projects', () => {
    const tracker = new ManagedChatGptOperationTracker();

    tracker.update('session-a', true);
    expect(tracker.busy).toBe(true);

    // The renderer may now be displaying session B, but the completion event still belongs to A.
    tracker.update('session-a', false);
    expect(tracker.busy).toBe(false);
    expect(tracker.begin('session-b')).toBe(true);
  });

  it('removes only the completed progress scope when multiple sessions were reported active', () => {
    const tracker = new ManagedChatGptOperationTracker();

    tracker.update('session-a', true);
    tracker.update('session-b', true);
    tracker.update('session-a', false);
    expect(tracker.busy).toBe(true);

    tracker.update('session-b', false);
    expect(tracker.busy).toBe(false);
  });

  it('tracks global progress independently from session progress', () => {
    const tracker = new ManagedChatGptOperationTracker();

    tracker.update(undefined, true);
    tracker.update('session-a', true);
    tracker.update('session-a', false);
    expect(tracker.busy).toBe(true);

    tracker.update(undefined, false);
    expect(tracker.busy).toBe(false);
  });

  it('does not clear an active operation when a different session completes', () => {
    const tracker = new ManagedChatGptOperationTracker();

    expect(tracker.begin('session-a')).toBe(true);
    tracker.finish('session-b');
    tracker.update('session-b', false);

    expect(tracker.busy).toBe(true);
    expect(tracker.begin('session-b')).toBe(false);
  });

  it('keeps the local click lease after main progress completes before the IPC reply', () => {
    const tracker = new ManagedChatGptOperationTracker();

    expect(tracker.begin()).toBe(true);
    tracker.update(undefined, true);
    tracker.update(undefined, false);

    // Main can publish completion before Electron resolves the renderer IPC promise. The original
    // click is still in flight, so a second click must remain coalesced until its finally runs.
    expect(tracker.busy).toBe(true);
    expect(tracker.begin()).toBe(false);

    tracker.finish();
    expect(tracker.busy).toBe(false);
    expect(tracker.begin()).toBe(true);
  });
});

describe('runManagedChatGptOperation', () => {
  it('enters the global setup operation when no project exists', async () => {
    const tracker = new ManagedChatGptOperationTracker();
    const setup = vi.fn(async (sessionId: string | undefined) => ({ sessionId }));

    const execution = await runManagedChatGptOperation(tracker, undefined, setup);

    expect(execution).toEqual({ result: { sessionId: undefined }, started: true });
    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(undefined);
    expect(tracker.busy).toBe(false);
  });

  it('coalesces repeated clicks when progress completes before the first IPC reply', async () => {
    const tracker = new ManagedChatGptOperationTracker();
    let completeSetup!: (value: string) => void;
    const setup = vi.fn(() => {
      tracker.update(undefined, true);
      tracker.update(undefined, false);
      return new Promise<string>((resolve) => {
        completeSetup = resolve;
      });
    });

    const first = runManagedChatGptOperation(tracker, undefined, setup);
    const repeated = await runManagedChatGptOperation(tracker, undefined, setup);

    expect(repeated).toEqual({ started: false });
    expect(setup).toHaveBeenCalledOnce();
    expect(tracker.busy).toBe(true);

    completeSetup('ready');
    await expect(first).resolves.toEqual({ result: 'ready', started: true });
    expect(tracker.busy).toBe(false);
  });

  it('releases the button lock after failure so a retry can start', async () => {
    const tracker = new ManagedChatGptOperationTracker();
    const button = { disabled: false };
    const setup = vi
      .fn<(sessionId: string | undefined) => Promise<string>>()
      .mockRejectedValueOnce(new Error('setup failed'))
      .mockResolvedValueOnce('ready');
    const click = async (): Promise<void> => {
      try {
        await runManagedChatGptOperation(tracker, undefined, async (sessionId) => {
          button.disabled = true;
          return setup(sessionId);
        });
      } finally {
        button.disabled = tracker.busy;
      }
    };

    await expect(click()).rejects.toThrow('setup failed');
    expect(button.disabled).toBe(false);
    expect(tracker.busy).toBe(false);

    await expect(click()).resolves.toBeUndefined();
    expect(setup).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
  });
});
