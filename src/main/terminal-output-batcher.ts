import type { PtyGeneration } from '../shared/contracts';

export const TERMINAL_OUTPUT_FLUSH_MS = 8;
export const TERMINAL_OUTPUT_FLUSH_BYTES = 64 * 1024;

export type TerminalOutputEmitter = (
  sessionId: string,
  ptyGeneration: PtyGeneration,
  data: string,
) => void;

export type TerminalGenerationCheck = (sessionId: string, ptyGeneration: PtyGeneration) => boolean;

export interface TerminalOutputBatcherOptions {
  emit: TerminalOutputEmitter;
  flushBytes?: number;
  flushMs?: number;
  isCurrentGeneration: TerminalGenerationCheck;
}

interface OutputBuffer {
  byteLength: number;
  chunks: string[];
  ptyGeneration: PtyGeneration;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Coalesces main-process terminal output without allowing an older PTY generation to disturb a
 * replacement generation's pending data. Every asynchronous flush retains the exact buffer it owns.
 */
export class TerminalOutputBatcher {
  private readonly buffers = new Map<string, OutputBuffer>();
  private disposed = false;
  private readonly emit: TerminalOutputEmitter;
  private readonly flushBytes: number;
  private readonly flushMs: number;
  private readonly isCurrentGeneration: TerminalGenerationCheck;

  public constructor(options: TerminalOutputBatcherOptions) {
    this.emit = options.emit;
    this.flushBytes = options.flushBytes ?? TERMINAL_OUTPUT_FLUSH_BYTES;
    this.flushMs = options.flushMs ?? TERMINAL_OUTPUT_FLUSH_MS;
    this.isCurrentGeneration = options.isCurrentGeneration;
  }

  public queue(sessionId: string, ptyGeneration: PtyGeneration, data: string): void {
    if (this.disposed) {
      return;
    }

    const previous = this.buffers.get(sessionId);
    if (previous) {
      if (ptyGeneration < previous.ptyGeneration) {
        return;
      }
      if (ptyGeneration > previous.ptyGeneration) {
        this.discard(sessionId, previous.ptyGeneration);
      }
    }

    const buffer = this.buffers.get(sessionId) ?? {
      byteLength: 0,
      chunks: [],
      ptyGeneration,
      timer: undefined,
    };
    buffer.chunks.push(data);
    buffer.byteLength += Buffer.byteLength(data, 'utf8');
    this.buffers.set(sessionId, buffer);

    if (buffer.byteLength >= this.flushBytes) {
      this.flushOwned(sessionId, ptyGeneration, buffer);
      return;
    }
    buffer.timer ??= setTimeout(() => {
      this.flushOwned(sessionId, ptyGeneration, buffer);
    }, this.flushMs);
  }

  public flush(sessionId: string, expectedGeneration: PtyGeneration): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer || buffer.ptyGeneration !== expectedGeneration) {
      return;
    }
    this.flushOwned(sessionId, expectedGeneration, buffer);
  }

  public discard(sessionId: string, expectedGeneration?: PtyGeneration): void {
    const buffer = this.buffers.get(sessionId);
    if (
      !buffer ||
      (expectedGeneration !== undefined && buffer.ptyGeneration !== expectedGeneration)
    ) {
      return;
    }

    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    if (this.buffers.get(sessionId) === buffer) {
      this.buffers.delete(sessionId);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const buffer of this.buffers.values()) {
      if (buffer.timer !== undefined) {
        clearTimeout(buffer.timer);
        buffer.timer = undefined;
      }
    }
    this.buffers.clear();
  }

  private flushOwned(
    sessionId: string,
    expectedGeneration: PtyGeneration,
    expectedBuffer: OutputBuffer,
  ): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer !== expectedBuffer || buffer.ptyGeneration !== expectedGeneration) {
      return;
    }

    this.discard(sessionId, expectedGeneration);
    if (
      !this.disposed &&
      buffer.chunks.length > 0 &&
      this.isCurrentGeneration(sessionId, expectedGeneration)
    ) {
      this.emit(sessionId, expectedGeneration, buffer.chunks.join(''));
    }
  }
}
