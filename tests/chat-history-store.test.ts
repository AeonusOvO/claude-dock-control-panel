import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStore } from '../src/main/chat-attachment-store';
import { ChatHistoryStore, replaceChatHistoryFileAtomically } from '../src/main/chat-history-store';

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

const fileSystemError = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

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

  it('keeps a renamed conversation title through later saves and reloads', () => {
    const { historyPath, store } = createStore();
    const created = store.save({
      messages: [{ content: '第一个问题', role: 'user' }],
      usage,
    });
    expect(created.title).toBe('第一个问题');
    expect(created.titleCustom).toBeUndefined();

    const renamed = store.rename(created.id, '  重构   计划  ');
    expect(renamed).toMatchObject({ title: '重构 计划', titleCustom: true });

    const appended = store.save({
      conversationId: created.id,
      messages: [
        { content: '第一个问题', role: 'user' },
        { content: '回答', role: 'assistant' },
        { content: '换个话题', role: 'user' },
      ],
      usage,
    });
    expect(appended.title).toBe('重构 计划');
    expect(store.list()[0]).toMatchObject({ title: '重构 计划', titleCustom: true });
    expect(
      new ChatHistoryStore(path.dirname(path.dirname(historyPath))).get(created.id),
    ).toMatchObject({ title: '重构 计划', titleCustom: true });
  });

  it('rejects empty, overlong and control-character conversation names', () => {
    const { store } = createStore();
    const created = store.save({ messages: [{ content: '标题', role: 'user' }], usage });

    expect(() => store.rename(created.id, '   ')).toThrow(/不能为空/);
    expect(() => store.rename(created.id, ' ')).toThrow(/不能为空/);
    expect(() => store.rename(created.id, 'x'.repeat(61))).toThrow(/不能超过 60/);
    expect(() => store.rename(created.id, 42)).toThrow(/无效/);
    expect(store.rename('9f1d3c2b-4a5e-4f6a-8b7c-0d1e2f3a4b5c', '不存在')).toBeUndefined();
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

describe('chat history atomic replacement', () => {
  it('uses a unique same-directory temporary path and exclusive private writes', () => {
    const target = 'C:\\profile\\claude\\chat-history.json';
    const temporaryIds = ['first-id', 'second-id'];
    const writeFile = vi.fn();
    const renameFile = vi.fn();
    const createTemporaryId = vi.fn(() => temporaryIds.shift() ?? 'unexpected-id');

    replaceChatHistoryFileAtomically(target, 'first', {
      createTemporaryId,
      renameFile,
      writeFile,
    });
    replaceChatHistoryFileAtomically(target, 'second', {
      createTemporaryId,
      renameFile,
      writeFile,
    });

    expect(writeFile).toHaveBeenNthCalledWith(1, `${target}.tmp-${process.pid}-first-id`, 'first', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      `${target}.tmp-${process.pid}-second-id`,
      'second',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    expect(renameFile).toHaveBeenNthCalledWith(1, `${target}.tmp-${process.pid}-first-id`, target);
    expect(renameFile).toHaveBeenNthCalledWith(2, `${target}.tmp-${process.pid}-second-id`, target);
  });

  it('does not delete an exclusive-create collision that it never owned', () => {
    const writeError = fileSystemError('EEXIST', 'temporary path collision');
    const renameFile = vi.fn();
    const unlinkFile = vi.fn();

    expect(() =>
      replaceChatHistoryFileAtomically('C:\\profile\\claude\\chat-history.json', 'next', {
        createTemporaryId: () => 'collision-id',
        renameFile,
        unlinkFile,
        writeFile: () => {
          throw writeError;
        },
      }),
    ).toThrow(writeError);
    expect(renameFile).not.toHaveBeenCalled();
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('retries only transient Windows rename failures with bounded delays', () => {
    const target = 'C:\\profile\\claude\\chat-history.json';
    const temporaryPath = `${target}.tmp-${process.pid}-retry-id`;
    const sleep = vi.fn();
    const renameFile = vi
      .fn()
      .mockImplementationOnce(() => {
        throw fileSystemError('EPERM');
      })
      .mockImplementationOnce(() => {
        throw fileSystemError('EBUSY');
      })
      .mockImplementationOnce(() => undefined);

    replaceChatHistoryFileAtomically(target, 'next', {
      createTemporaryId: () => 'retry-id',
      renameFile,
      sleep,
      writeFile: vi.fn(),
    });

    expect(renameFile).toHaveBeenCalledTimes(3);
    expect(renameFile).toHaveBeenCalledWith(temporaryPath, target);
    expect(sleep.mock.calls).toEqual([[5], [10]]);
  });

  it('preserves the last valid target and original error after persistent rename failure', () => {
    const { historyPath } = createStore();
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, 'last-valid-history', 'utf8');
    const temporaryPath = `${historyPath}.tmp-${process.pid}-persistent-id`;
    const renameError = fileSystemError('EACCES', 'destination is temporarily locked');
    const renameFile = vi.fn(() => {
      throw renameError;
    });
    const sleep = vi.fn();
    let caught: unknown;

    try {
      replaceChatHistoryFileAtomically(historyPath, 'replacement', {
        createTemporaryId: () => 'persistent-id',
        renameFile,
        sleep,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(renameError);
    expect(renameFile).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls).toEqual([[5], [10], [20], [40], [80]]);
    expect(readFileSync(historyPath, 'utf8')).toBe('last-valid-history');
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it('does not retry non-transient rename failures and still cleans only its temporary file', () => {
    const { historyPath } = createStore();
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, 'last-valid-history', 'utf8');
    const temporaryPath = `${historyPath}.tmp-${process.pid}-fatal-id`;
    const renameError = fileSystemError('EIO', 'disk failure');
    const renameFile = vi.fn(() => {
      throw renameError;
    });
    const sleep = vi.fn();
    let caught: unknown;

    try {
      replaceChatHistoryFileAtomically(historyPath, 'replacement', {
        createTemporaryId: () => 'fatal-id',
        renameFile,
        sleep,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(renameError);
    expect(renameFile).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(readFileSync(historyPath, 'utf8')).toBe('last-valid-history');
    expect(existsSync(temporaryPath)).toBe(false);
  });
});
