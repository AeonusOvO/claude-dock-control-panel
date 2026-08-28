import { createHash } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import type { ModelTokenUsage } from '../../shared/contracts';

export interface TranscriptUsageRequest {
  epoch: string;
  since: number;
  file: string;
}
export interface TranscriptUsageResult {
  epoch: string;
  source: string;
  tokens: ModelTokenUsage;
  available: boolean;
  partial: boolean;
}

export const emptyTokens = (): ModelTokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
});
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

interface Cursor {
  offset: number;
  pending: Buffer;
  skipping: boolean;
  partial: boolean;
  observed: boolean;
  tokens: ModelTokenUsage;
  messages: Map<string, ModelTokenUsage>;
}

/** Runs only in a worker in production. Never returns message bodies or reads outside projects. */
export class TranscriptUsageReader {
  private epoch = '';
  private readonly cursors = new Map<string, Cursor>();

  public constructor(private readonly root: string) {}

  public async read(request: TranscriptUsageRequest): Promise<TranscriptUsageResult[]> {
    if (this.epoch !== request.epoch) {
      this.epoch = request.epoch;
      this.cursors.clear();
    }
    const root = await realpath(this.root);
    const file = await realpath(request.file);
    if (!inside(root, file) || !/^[a-f0-9-]{36}\.jsonl$/i.test(path.basename(file))) {
      throw new Error('Unsupported transcript path');
    }
    const results = [await this.readFile(file, request)];
    // Claude stores delegated agent requests separately; include their reported usage exactly once.
    const agents = path.join(file.slice(0, -6), 'subagents');
    try {
      const directory = await realpath(agents);
      if (!inside(root, directory)) return results;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^agent-[a-z0-9_-]+\.jsonl$/i.test(entry.name)) continue;
        const child = await realpath(path.join(directory, entry.name));
        if (inside(directory, child)) results.push(await this.readFile(child, request));
      }
    } catch {
      // Most conversations have no subagents. A missing optional directory is not a failure.
    }
    return results;
  }

  private consume(line: Buffer, cursor: Cursor, since: number): void {
    try {
      const event = JSON.parse(line.toString('utf8'));
      if (
        event?.type !== 'assistant' ||
        !event.message?.usage ||
        Date.parse(event.timestamp) < since
      )
        return;
      if (!Number.isFinite(Date.parse(event.timestamp))) return;
      const id = event.message.id;
      if (typeof id !== 'string' || id.length > 256) return;
      const usage = event.message.usage;
      const current = {
        input: number(usage.input_tokens),
        output: number(usage.output_tokens),
        cacheRead: number(usage.cache_read_input_tokens),
        cacheCreation: number(usage.cache_creation_input_tokens),
      };
      const key = id;
      if (cursor.messages.size >= 100_000 && !cursor.messages.has(key)) {
        cursor.partial = true;
        return;
      }
      const previous = cursor.messages.get(key) ?? emptyTokens();
      for (const field of Object.keys(current) as (keyof ModelTokenUsage)[]) {
        const maximum = Math.max(previous[field], current[field]);
        cursor.tokens[field] += maximum - previous[field];
        previous[field] = maximum;
      }
      cursor.messages.set(key, previous);
      cursor.observed = true;
    } catch {
      cursor.partial = true;
    }
  }

  private async readFile(
    file: string,
    request: TranscriptUsageRequest,
  ): Promise<TranscriptUsageResult> {
    let cursor = this.cursors.get(file);
    if (!cursor) {
      cursor = {
        offset: 0,
        pending: Buffer.alloc(0),
        skipping: false,
        partial: false,
        observed: false,
        tokens: emptyTokens(),
        messages: new Map(),
      };
      this.cursors.set(file, cursor);
    }
    const handle = await open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size < cursor.offset) {
        cursor.offset = 0;
        cursor.pending = Buffer.alloc(0);
        cursor.skipping = false;
      }
      const chunk = Buffer.alloc(64 * 1024);
      while (cursor.offset < size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - cursor.offset),
          cursor.offset,
        );
        if (!bytesRead) break;
        cursor.offset += bytesRead;
        const buffer = Buffer.concat([cursor.pending, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
          if (!cursor.skipping && end > start)
            this.consume(buffer.subarray(start, end), cursor, request.since);
          cursor.skipping = false;
          start = end + 1;
        }
        cursor.pending = Buffer.from(buffer.subarray(start));
        // A pathological line must not cause unbounded allocation, even in the worker.
        if (cursor.pending.length > 2 * 1024 * 1024) {
          cursor.pending = Buffer.alloc(0);
          cursor.skipping = true;
          cursor.partial = true;
        }
        await yieldToIo();
      }
    } finally {
      await handle.close();
    }
    return {
      epoch: request.epoch,
      source: createHash('sha256').update(file.toLowerCase()).digest('hex'),
      tokens: { ...cursor.tokens },
      available: cursor.observed,
      partial: cursor.partial,
    };
  }
}
