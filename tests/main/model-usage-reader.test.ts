import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptUsageReader } from '../../src/main/usage/transcript-reader';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const since = Date.parse('2026-08-28T00:00:00Z');
const record = (id: string, input = 100, output = 20, timestamp = since + 1000) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(timestamp).toISOString(),
    message: {
      id,
      content: [{ type: 'text', text: 'private conversation body' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    },
  }) + '\n';
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudedock-usage-reader-'));
  roots.push(root);
  const projects = path.join(root, 'projects');
  await mkdir(projects);
  const file = path.join(projects, '00000000-1111-2222-3333-444444444444.jsonl');
  await writeFile(file, '');
  return {
    root,
    projects,
    file,
    reader: new TranscriptUsageReader(projects),
    request: { file, since, epoch: 'one' },
  };
};

describe('incremental API usage reader', () => {
  it('deduplicates repeated streaming message IDs and sums cache usage without retaining text', async () => {
    const { file, reader, request } = await fixture();
    await writeFile(
      file,
      record('old', 9000, 1000, since - 1) +
        record('one') +
        record('one', 100, 50) +
        record('two', 200, 10),
    );
    const [result] = await reader.read(request);
    expect(result?.tokens).toEqual({ input: 300, output: 60, cacheRead: 60, cacheCreation: 80 });
    expect(JSON.stringify(result)).not.toContain('private conversation');
    expect(await reader.read(request)).toEqual([result]);
    await appendFile(file, record('three', 1, 2));
    expect((await reader.read(request))[0]?.tokens.input).toBe(301);
  });

  it('holds partial UTF-8 lines until complete and recovers after malformed records', async () => {
    const { file, reader, request } = await fixture();
    const line = record('消息');
    const split = Buffer.from(line).indexOf(Buffer.from('消息')) + 1;
    await writeFile(file, Buffer.from(line).subarray(0, split));
    expect((await reader.read(request))[0]?.available).toBe(false);
    await appendFile(file, Buffer.from(line).subarray(split));
    await appendFile(file, 'malformed\n' + record('two'));
    expect((await reader.read(request))[0]).toMatchObject({
      available: true,
      partial: true,
      tokens: { input: 200 },
    });
  });

  it('counts subagent files separately and does not double count after transcript truncation', async () => {
    const { file, reader, request } = await fixture();
    await writeFile(file, record('one') + record('two'));
    const agents = path.join(file.slice(0, -6), 'subagents');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, 'agent-abcd.jsonl'), record('agent', 300));
    expect((await reader.read(request)).map((result) => result.tokens.input)).toEqual([200, 300]);
    await writeFile(file, record('one'));
    expect((await reader.read(request))[0]?.tokens.input).toBe(200);
    await appendFile(file, record('three'));
    expect((await reader.read(request))[0]?.tokens.input).toBe(300);
  });

  it('uses a fresh timestamp cutoff on reconnect, not the context window counter', async () => {
    const { file, reader, request } = await fixture();
    await writeFile(
      file,
      record('before', 100, 20, since + 1000) + record('after', 200, 20, since + 5000),
    );
    expect((await reader.read(request))[0]?.tokens.input).toBe(300);
    expect(
      (await reader.read({ ...request, epoch: 'two', since: since + 4000 }))[0]?.tokens.input,
    ).toBe(200);
  });

  it('rejects paths outside the project root and skips bounded oversized lines', async () => {
    const { root, file, reader, request } = await fixture();
    const outside = path.join(root, path.basename(file));
    await writeFile(outside, record('secret'));
    await expect(reader.read({ ...request, file: outside })).rejects.toThrow(
      'Unsupported transcript path',
    );
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024) + '\n' + record('valid'));
    expect((await reader.read(request))[0]).toMatchObject({
      partial: true,
      tokens: { input: 100 },
    });
  });
});
