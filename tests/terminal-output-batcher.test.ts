import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_OUTPUT_FLUSH_BYTES,
  TERMINAL_OUTPUT_FLUSH_MS,
  TerminalOutputBatcher,
  type TerminalOutputEmitter,
} from '../src/main/terminal-output-batcher';
import type { PtyGeneration } from '../src/shared/contracts';

interface EmittedOutput {
  data: string;
  ptyGeneration: PtyGeneration;
  sessionId: string;
}

const createEmitter = (emitted: EmittedOutput[]): TerminalOutputEmitter =>
  vi.fn((sessionId, ptyGeneration, data) => {
    emitted.push({ data, ptyGeneration, sessionId });
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TerminalOutputBatcher', () => {
  it('preserves the 8ms coalescing delay and 64KB immediate flush threshold', async () => {
    expect(TERMINAL_OUTPUT_FLUSH_MS).toBe(8);
    expect(TERMINAL_OUTPUT_FLUSH_BYTES).toBe(64 * 1024);

    const emitted: EmittedOutput[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      isCurrentGeneration: (_sessionId, ptyGeneration) => ptyGeneration === 1,
    });

    batcher.queue('session-delay', 1, 'first');
    batcher.queue('session-delay', 1, ' second');
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS - 1);
    expect(emitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([
      { data: 'first second', ptyGeneration: 1, sessionId: 'session-delay' },
    ]);

    batcher.queue('session-threshold', 1, 'x'.repeat(TERMINAL_OUTPUT_FLUSH_BYTES - 1));
    expect(emitted).toHaveLength(1);
    batcher.queue('session-threshold', 1, 'y');
    expect(emitted[1]).toEqual({
      data: 'x'.repeat(TERMINAL_OUTPUT_FLUSH_BYTES - 1) + 'y',
      ptyGeneration: 1,
      sessionId: 'session-threshold',
    });
  });

  it('counts the immediate flush threshold in UTF-8 bytes', () => {
    const emitted: EmittedOutput[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      flushBytes: 4,
      isCurrentGeneration: () => true,
    });
    const data = '€x';

    expect(data).toHaveLength(2);
    expect(Buffer.byteLength(data, 'utf8')).toBe(4);
    batcher.queue('session-utf8', 1, data);

    expect(emitted).toEqual([{ data, ptyGeneration: 1, sessionId: 'session-utf8' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes final queued output synchronously without crossing generations', () => {
    const events: string[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: (sessionId, ptyGeneration, data) => {
        events.push(`data:${sessionId}:${ptyGeneration}:${data}`);
      },
      isCurrentGeneration: (_sessionId, ptyGeneration) => ptyGeneration === 2,
    });

    batcher.queue('session-1', 2, 'final output');
    batcher.flush('session-1', 1);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    batcher.flush('session-1', 2);
    events.push('state:stopped:2');

    expect(events).toEqual(['data:session-1:2:final output', 'state:stopped:2']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits every preceding byte before a permission-mode probe is sent', () => {
    const events: string[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: (_sessionId, _ptyGeneration, data) => events.push(`data:${data}`),
      isCurrentGeneration: () => true,
    });

    batcher.queue('session-1', 3, 'prompt repaint');
    batcher.flush('session-1', 3);
    events.push('permission-mode-probe');

    expect(events).toEqual(['data:prompt repaint', 'permission-mode-probe']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a newer generation replace an older buffer without letting late old data evict it', async () => {
    const currentGenerations = new Map<string, PtyGeneration>([['session-1', 1]]);
    const emitted: EmittedOutput[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      isCurrentGeneration: (sessionId, ptyGeneration) =>
        currentGenerations.get(sessionId) === ptyGeneration,
    });

    batcher.queue('session-1', 1, 'old');
    currentGenerations.set('session-1', 2);
    batcher.queue('session-1', 2, 'new');
    batcher.queue('session-1', 1, ' late-old');
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS);

    expect(emitted).toEqual([{ data: 'new', ptyGeneration: 2, sessionId: 'session-1' }]);
  });

  it('does not let a stale cancelled timer emit or delete its replacement buffer', async () => {
    const scheduledCallbacks: Array<() => void> = [];
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      scheduledCallbacks.push(callback);
      return schedule(callback, delay);
    }) as typeof setTimeout);

    let currentGeneration: PtyGeneration = 1;
    const emitted: EmittedOutput[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      isCurrentGeneration: (_sessionId, ptyGeneration) => ptyGeneration === currentGeneration,
    });

    batcher.queue('session-1', 1, 'old');
    currentGeneration = 2;
    batcher.queue('session-1', 2, 'replacement');
    expect(scheduledCallbacks).toHaveLength(2);

    scheduledCallbacks[0]!();
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS);
    expect(emitted).toEqual([{ data: 'replacement', ptyGeneration: 2, sessionId: 'session-1' }]);
  });

  it('scopes discard to the expected generation while an unscoped discard removes any buffer', async () => {
    const emitted: EmittedOutput[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      isCurrentGeneration: (_sessionId, ptyGeneration) => ptyGeneration === 2,
    });

    batcher.queue('session-1', 2, 'keep');
    batcher.discard('session-1', 1);
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS);
    expect(emitted).toEqual([{ data: 'keep', ptyGeneration: 2, sessionId: 'session-1' }]);

    batcher.queue('session-1', 2, 'drop');
    batcher.discard('session-1');
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS);
    expect(emitted).toHaveLength(1);
  });

  it('checks the live workspace generation before every flush', async () => {
    let currentGeneration: PtyGeneration = 4;
    const emitted: EmittedOutput[] = [];
    const isCurrentGeneration = vi.fn(
      (_sessionId: string, ptyGeneration: PtyGeneration) => ptyGeneration === currentGeneration,
    );
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      isCurrentGeneration,
    });

    batcher.queue('session-1', 4, 'stale-at-flush');
    currentGeneration = 5;
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS);

    expect(isCurrentGeneration).toHaveBeenCalledWith('session-1', 4);
    expect(emitted).toEqual([]);
  });

  it('dispose cancels every timer, clears every buffer, and rejects later queueing', async () => {
    const emitted: EmittedOutput[] = [];
    const batcher = new TerminalOutputBatcher({
      emit: createEmitter(emitted),
      isCurrentGeneration: () => true,
    });

    batcher.queue('session-1', 1, 'one');
    batcher.queue('session-2', 7, 'two');
    expect(vi.getTimerCount()).toBe(2);

    batcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
    batcher.queue('session-3', 9, 'after-dispose');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_FLUSH_MS);
    expect(emitted).toEqual([]);
  });
});
