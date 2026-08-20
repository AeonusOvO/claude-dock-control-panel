import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalWritePlan,
  TerminalOutputPump,
  TERMINAL_WRITE_QUANTUM_UNITS,
} from '../../src/renderer/platform/terminal-output-pump';

const createHarness = (writeQuantumUnits = TERMINAL_WRITE_QUANTUM_UNITS) => {
  const applied: number[] = [];
  const callbacks: Array<() => void> = [];
  const frames = new Map<number, () => void>();
  const writes: string[] = [];
  let current = true;
  let nextFrame = 0;
  const pump = new TerminalOutputPump({
    cancelFrame: (handle) => frames.delete(handle),
    isCurrent: () => current,
    onAppliedRevision: (revision) => applied.push(revision),
    scheduleFrame: (callback) => {
      const handle = ++nextFrame;
      frames.set(handle, callback);
      return handle;
    },
    write: (data, callback) => {
      writes.push(data);
      callbacks.push(callback);
    },
    writeQuantumUnits,
  });
  const runFrame = (): void => {
    const entry = frames.entries().next().value as [number, () => void] | undefined;
    if (!entry) {
      throw new Error('No terminal output frame is scheduled.');
    }
    frames.delete(entry[0]);
    entry[1]();
  };
  const completeWrite = (): void => {
    const callback = callbacks.shift();
    if (!callback) {
      throw new Error('No terminal write is in flight.');
    }
    callback();
  };
  return {
    applied,
    callbacks,
    completeWrite,
    frames,
    pump,
    runFrame,
    setCurrent: (value: boolean) => {
      current = value;
    },
    writes,
  };
};

describe('TerminalOutputPump', () => {
  it('keeps exactly one xterm write in flight without losing queued output', () => {
    const harness = createHarness(6);

    expect(harness.pump.enqueue('one')).toBe(1);
    expect(harness.pump.enqueue('two')).toBe(2);
    expect(harness.frames.size).toBe(1);
    harness.runFrame();
    expect(harness.writes).toEqual(['onetwo']);
    expect(harness.callbacks).toHaveLength(1);

    expect(harness.pump.enqueue('three')).toBe(3);
    expect(harness.frames.size).toBe(0);
    expect(harness.callbacks).toHaveLength(1);

    harness.completeWrite();
    expect(harness.applied).toEqual([2]);
    expect(harness.frames.size).toBe(1);
    harness.runFrame();
    expect(harness.writes).toEqual(['onetwo', 'three']);
    harness.completeWrite();

    expect(harness.applied).toEqual([2, 3]);
    expect(harness.writes.join('')).toBe('onetwothree');
  });

  it('bounds UTF-16 write quanta without splitting surrogate pairs', () => {
    const harness = createHarness(3);
    const data = 'ab😀cd';
    harness.pump.enqueue(data);

    while (harness.frames.size > 0 || harness.callbacks.length > 0) {
      if (harness.frames.size > 0) {
        harness.runFrame();
      }
      if (harness.callbacks.length > 0) {
        harness.completeWrite();
      }
    }

    expect(harness.writes).toEqual(['ab', '😀c', 'd']);
    expect(harness.writes.join('')).toBe(data);
    expect(harness.writes.every((write) => write.length <= 3)).toBe(true);
    for (let index = 0; index < harness.writes.length - 1; index += 1) {
      const left = harness.writes[index]!;
      const right = harness.writes[index + 1]!;
      expect(left.charCodeAt(left.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
      expect(right.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    }
    expect(harness.applied).toEqual([1]);
  });

  it('keeps a surrogate pair intact when two IPC revisions meet at the quantum boundary', () => {
    const harness = createHarness(3);
    harness.pump.enqueue('ab\ud83d');
    harness.pump.enqueue('\ude00c');

    while (harness.frames.size > 0 || harness.callbacks.length > 0) {
      if (harness.frames.size > 0) {
        harness.runFrame();
      }
      if (harness.callbacks.length > 0) {
        harness.completeWrite();
      }
    }

    expect(harness.writes).toEqual(['ab', '😀c']);
    expect(harness.writes.join('')).toBe('ab😀c');
    expect(harness.applied).toEqual([2]);
  });

  it('buffers a cross-revision surrogate when the later revision exceeds the remaining quantum', () => {
    const harness = createHarness(3);
    harness.pump.enqueue('ab\ud83d');
    harness.pump.enqueue('\ude00xxxx');

    harness.runFrame();
    expect(harness.writes).toEqual(['ab']);
    harness.completeWrite();
    expect(harness.applied).toEqual([]);

    harness.runFrame();
    expect(harness.writes).toEqual(['ab', '😀']);
    harness.completeWrite();
    expect(harness.applied).toEqual([1]);

    while (harness.frames.size > 0 || harness.callbacks.length > 0) {
      if (harness.frames.size > 0) {
        harness.runFrame();
      }
      if (harness.callbacks.length > 0) {
        harness.completeWrite();
      }
    }

    expect(harness.writes).toEqual(['ab', '😀', 'xxx', 'x']);
    expect(harness.writes.join('')).toBe('ab😀xxxx');
    expect(harness.applied).toEqual([1, 2]);
  });

  it('advances applied revisions only after their complete data reaches xterm', () => {
    const harness = createHarness(3);
    harness.pump.enqueue('abc');
    harness.pump.enqueue('def');

    harness.runFrame();
    expect(harness.writes).toEqual(['abc']);
    expect(harness.pump.appliedRevision).toBe(0);
    harness.completeWrite();
    expect(harness.pump.appliedRevision).toBe(1);

    harness.runFrame();
    harness.completeWrite();
    expect(harness.pump.appliedRevision).toBe(2);
    expect(harness.applied).toEqual([1, 2]);
  });

  it('keeps output beyond the former 512 KiB limit lossless', () => {
    const harness = createHarness();
    const data = `${'x'.repeat(600 * 1024)}😀done`;
    harness.pump.enqueue(data);

    while (harness.frames.size > 0 || harness.callbacks.length > 0) {
      if (harness.frames.size > 0) {
        harness.runFrame();
      }
      if (harness.callbacks.length > 0) {
        harness.completeWrite();
      }
    }

    expect(harness.writes.length).toBeGreaterThan(1);
    expect(harness.writes.join('')).toBe(data);
    expect(harness.pump.appliedRevision).toBe(1);
  });

  it('does not let a late old-generation callback mutate a replacement pump', () => {
    const old = createHarness(4);
    old.pump.enqueue('old-output');
    old.runFrame();
    old.setCurrent(false);
    old.completeWrite();

    expect(old.applied).toEqual([]);
    expect(old.frames.size).toBe(0);

    const replacement = createHarness(4);
    replacement.pump.enqueue('new');
    replacement.runFrame();
    replacement.completeWrite();
    expect(replacement.writes).toEqual(['new']);
    expect(replacement.applied).toEqual([1]);
  });

  it('cancels scheduled work and ignores an in-flight completion after disposal', () => {
    const scheduled = createHarness();
    scheduled.pump.enqueue('scheduled');
    expect(scheduled.frames.size).toBe(1);
    scheduled.pump.dispose();
    expect(scheduled.frames.size).toBe(0);

    const inFlight = createHarness();
    inFlight.pump.enqueue('writing');
    inFlight.runFrame();
    inFlight.pump.dispose();
    inFlight.completeWrite();
    expect(inFlight.applied).toEqual([]);
  });
});

describe('createTerminalWritePlan', () => {
  it('does not start a later revision unless the same plan can finish it', () => {
    expect(
      createTerminalWritePlan(
        [
          { data: 'ab', revision: 1 },
          { data: 'cdef', revision: 2 },
        ],
        3,
      ),
    ).toEqual({
      completedRevision: 1,
      data: 'ab',
      endIndex: 0,
      endOffset: 2,
      units: 2,
    });
  });

  it('rejects a quantum that cannot hold one surrogate pair', () => {
    expect(() => createTerminalWritePlan([{ data: 'x', revision: 1 }], 1)).toThrow(
      /at least two UTF-16 units/,
    );
    expect(
      () =>
        new TerminalOutputPump({
          cancelFrame: vi.fn(),
          isCurrent: () => true,
          onAppliedRevision: vi.fn(),
          scheduleFrame: () => 1,
          write: vi.fn(),
          writeQuantumUnits: 1,
        }),
    ).toThrow(/at least two UTF-16 units/);
  });
});
