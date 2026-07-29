import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStore } from '../src/main/chat-attachment-store';
import { ChatHistoryStore } from '../src/main/chat-history-store';

const fixtureRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-chat-history-'));
  fixtureRoots.push(fixtureRoot);
  return {
    historyPath: path.join(fixtureRoot, 'claude', 'chat-history.json'),
    store: new ChatHistoryStore(fixtureRoot),
  };
};

const usage = {
  inputTokens: 12,
  outputTokens: 4,
  source: 'provider' as const,
  totalTokens: 16,
};

describe('independent chat history store', () => {
  it('creates, updates and reloads a conversation without losing messages or usage', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
    const { historyPath, store } = createStore();
    const created = store.save({
      messages: [{ content: '请帮我分析这个项目的结构', role: 'user' }],
      usage,
    });

    vi.setSystemTime(new Date('2026-07-28T12:01:00Z'));
    const updated = store.save({
      conversationId: created.id,
      messages: [
        { content: '请帮我分析这个项目的结构', role: 'user' },
        { content: '可以，我会先查看入口。', role: 'assistant' },
      ],
      usage: { ...usage, outputTokens: 9, totalTokens: 21 },
    });

    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(updated.title).toBe('请帮我分析这个项目的结构');
    expect(new ChatHistoryStore(path.dirname(path.dirname(historyPath))).get(created.id)).toEqual(
      updated,
    );
    expect(readFileSync(historyPath, 'utf8')).toContain('请帮我分析这个项目的结构');
  });

  it('sorts recent conversations first and deletes only the requested UUID', () => {
    vi.useFakeTimers();
    const { store } = createStore();
    vi.setSystemTime(1_000);
    const first = store.save({
      messages: [{ content: 'first', role: 'user' }],
      usage,
    });
    vi.setSystemTime(2_000);
    const second = store.save({
      messages: [{ content: 'second', role: 'user' }],
      usage,
    });

    expect(store.list().map((conversation) => conversation.id)).toEqual([second.id, first.id]);
    expect(store.delete(first.id)).toBe(true);
    expect(store.delete(first.id)).toBe(false);
    expect(store.list().map((conversation) => conversation.id)).toEqual([second.id]);
  });

  it('rejects malformed ids and oversized message lists', () => {
    const { store } = createStore();
    expect(() => store.get('../chat-history.json')).toThrow(/标识/);
    expect(() =>
      store.save({
        messages: Array.from({ length: 101 }, () => ({ content: 'x', role: 'user' as const })),
        usage,
      }),
    ).toThrow(/数量/);
  });

  it('keeps only the 50 newest conversations', () => {
    vi.useFakeTimers();
    const { store } = createStore();
    for (let index = 0; index < 52; index += 1) {
      vi.setSystemTime(index + 1);
      store.save({
        messages: [{ content: `conversation-${index}`, role: 'user' }],
        usage,
      });
    }

    expect(store.list()).toHaveLength(50);
    expect(store.list().at(0)?.title).toBe('conversation-51');
    expect(store.list().at(-1)?.title).toBe('conversation-2');
  });

  it('quarantines corrupt history and refuses cleanup or overwrite', () => {
    const { historyPath, store } = createStore();
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, '{not-json', 'utf8');

    expect(() => store.list()).toThrow(/停止覆盖历史和清理附件/);
    expect(readFileSync(historyPath, 'utf8')).toBe('{not-json');
    expect(readFileSync(`${historyPath}.corrupt.bak`, 'utf8')).toBe('{not-json');
    expect(() =>
      store.save({
        messages: [{ content: '重新开始', role: 'user' }],
        usage,
      }),
    ).toThrow(/停止覆盖历史和清理附件/);
    expect(readFileSync(historyPath, 'utf8')).toBe('{not-json');
  });

  it('reads 1.x string history as blocks and writes version 2 only after an explicit save', () => {
    const { historyPath, store } = createStore();
    const conversationId = '8f9aa605-adb6-4e2b-a25a-607e14bad666';
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(
      historyPath,
      JSON.stringify({
        conversations: [
          {
            createdAt: 100,
            id: conversationId,
            messageCount: 1,
            messages: [{ content: '旧版消息', role: 'user' }],
            title: '旧版消息',
            updatedAt: 100,
            usage,
          },
        ],
        version: 1,
      }),
      'utf8',
    );

    const migrated = store.get(conversationId);
    expect(migrated?.messages).toEqual([
      { content: [{ text: '旧版消息', type: 'text' }], role: 'user' },
    ]);
    expect(JSON.parse(readFileSync(historyPath, 'utf8'))).toHaveProperty('version', 1);

    store.save({
      conversationId,
      messages: migrated!.messages,
      usage,
    });
    const persisted = JSON.parse(readFileSync(historyPath, 'utf8')) as {
      conversations: Array<{ messages: unknown }>;
      version: number;
    };
    expect(persisted.version).toBe(2);
    expect(persisted.conversations[0]?.messages).toEqual(migrated?.messages);
  });

  it('deep-clones nested blocks and removes an unreferenced local attachment with its conversation', async () => {
    const { historyPath, store } = createStore();
    const userDataPath = path.dirname(path.dirname(historyPath));
    const sourcePath = path.join(userDataPath, 'source.txt');
    writeFileSync(sourcePath, 'attachment', 'utf8');
    const attachmentStore = new ChatAttachmentStore(userDataPath);
    const [attachment] = await attachmentStore.importFiles([sourcePath]);
    const created = store.save({
      messages: [
        {
          content: [
            {
              fileName: attachment!.fileName,
              mediaType: attachment!.mediaType,
              source: { attachmentId: attachment!.attachmentId, type: 'local' },
              type: 'document',
            },
            { text: '分析附件', type: 'text' },
          ],
          role: 'user',
        },
      ],
      usage,
    });

    const returnedBlock = created.messages[0]?.content;
    if (!Array.isArray(returnedBlock) || !returnedBlock[0] || returnedBlock[0].type === 'text') {
      throw new Error('expected attachment block');
    }
    returnedBlock[0].source = { fileId: 'mutated', type: 'file' };
    expect(store.get(created.id)?.messages[0]?.content).toMatchObject([
      { source: { attachmentId: attachment!.attachmentId, type: 'local' } },
      { text: '分析附件', type: 'text' },
    ]);

    expect(store.delete(created.id)).toBe(true);
    expect(() => attachmentStore.get(attachment!.attachmentId)).toThrow();
  });

  it('refuses to persist base64 payloads in chat-history.json', () => {
    const { store } = createStore();
    expect(() =>
      store.save({
        messages: [
          {
            content: [
              {
                mediaType: 'image/png',
                source: { data: 'iVBORw==', type: 'base64' },
                type: 'image',
              },
            ],
            role: 'user',
          },
        ],
        usage,
      }),
    ).toThrow(/不能保存 base64/);
  });
});
