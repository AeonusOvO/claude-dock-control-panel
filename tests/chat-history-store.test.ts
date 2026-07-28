import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('recovers safely from corrupt history without overwriting it until the next explicit save', () => {
    const { historyPath, store } = createStore();
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, '{not-json', 'utf8');

    expect(store.list()).toEqual([]);
    expect(readFileSync(historyPath, 'utf8')).toBe('{not-json');
    store.save({
      messages: [{ content: '重新开始', role: 'user' }],
      usage,
    });
    expect(new ChatHistoryStore(path.dirname(path.dirname(historyPath))).list()).toHaveLength(1);
  });
});
