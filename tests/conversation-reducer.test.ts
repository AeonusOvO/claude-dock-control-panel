import { describe, expect, it } from 'vitest';
import { reduceConversationEvent } from '../src/shared/conversation-reducer';
import type { ConversationEvent } from '../src/shared/native-conversation';

const base = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  emittedAt: 1,
  projectPath: 'D:\\Projects\\Example',
  revision: 1,
  runtime: 'claude' as const,
};

describe('conversation reducer', () => {
  it('preserves block order and whitespace while streaming', () => {
    let snapshot = reduceConversationEvent(undefined, {
      ...base,
      ownerKind: 'native',
      sequence: 1,
      type: 'conversation.started',
    });
    const events: ConversationEvent[] = [
      {
        ...base,
        blockId: 'text-0',
        blockType: 'text',
        delta: '第一行\n\n---\n',
        messageId: 'assistant-1',
        sequence: 2,
        type: 'message.delta',
      },
      {
        ...base,
        blockId: 'thinking-1',
        blockType: 'thinking',
        delta: '  保留缩进',
        messageId: 'assistant-1',
        sequence: 3,
        type: 'message.delta',
      },
      {
        ...base,
        blockId: 'text-0',
        blockType: 'text',
        delta: '\n```ts\nconst x = 1;\n```',
        messageId: 'assistant-1',
        sequence: 4,
        type: 'message.delta',
      },
    ];
    for (const event of events) snapshot = reduceConversationEvent(snapshot, event);

    expect(snapshot?.messages[0]?.blocks).toEqual([
      {
        id: 'text-0',
        text: '第一行\n\n---\n\n```ts\nconst x = 1;\n```',
        type: 'text',
      },
      { id: 'thinking-1', text: '  保留缩进', type: 'thinking' },
    ]);
  });

  it('ignores late events from prior revisions and duplicate sequences', () => {
    let snapshot = reduceConversationEvent(undefined, {
      ...base,
      ownerKind: 'native',
      sequence: 1,
      type: 'conversation.started',
    });
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      phase: 'running',
      revision: 2,
      sequence: 1,
      type: 'conversation.phase',
    });
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      message: '迟到错误',
      sequence: 99,
      type: 'conversation.error',
    });
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      phase: 'idle',
      revision: 2,
      sequence: 1,
      type: 'conversation.phase',
    });

    expect(snapshot?.phase).toBe('running');
    expect(snapshot?.error).toBeUndefined();
  });

  it('keeps untouched messages identical so one token does not clone the transcript', () => {
    let snapshot = reduceConversationEvent(undefined, {
      ...base,
      ownerKind: 'native',
      sequence: 1,
      type: 'conversation.started',
    });
    for (const [index, id] of ['m-0', 'm-1', 'm-2'].entries()) {
      snapshot = reduceConversationEvent(snapshot, {
        ...base,
        message: {
          blocks: [{ id: `${id}:0`, text: '既有内容', type: 'text' }],
          createdAt: 1,
          id,
          role: 'assistant',
          status: 'complete',
        },
        sequence: 2 + index,
        type: 'message.upsert',
      });
    }
    const before = snapshot!.messages;

    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      blockId: 'm-2:0',
      blockType: 'text',
      delta: '增量',
      messageId: 'm-2',
      sequence: 10,
      type: 'message.delta',
    });
    const after = snapshot!.messages;

    // Structural sharing: only the mutated message may be a new object. Cloning every message per
    // streamed token is what made long native conversations freeze.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    // The prior snapshot must not observe the mutation — the renderer diffs against it.
    expect((before[2]?.blocks[0] as { text: string }).text).toBe('既有内容');
    expect((after[2]?.blocks[0] as { text: string }).text).toBe('既有内容增量');
  });

  it('bumps a version on every message mutation so renderers can diff in O(1)', () => {
    let snapshot = reduceConversationEvent(undefined, {
      ...base,
      ownerKind: 'native',
      sequence: 1,
      type: 'conversation.started',
    });
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      blockId: 'b-0',
      blockType: 'text',
      delta: '一',
      messageId: 'assistant-1',
      sequence: 2,
      type: 'message.delta',
    });
    expect(snapshot?.messages[0]?.version).toBe(1);

    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      blockId: 'b-0',
      blockType: 'text',
      delta: '二',
      messageId: 'assistant-1',
      sequence: 3,
      type: 'message.delta',
    });
    expect(snapshot?.messages[0]?.version).toBe(2);

    // A tool progress tick mutates the same message, so it has to advance the version too.
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      block: {
        id: 'tool-0',
        input: {},
        name: 'Bash',
        status: 'running',
        summary: '已运行 1.0 秒',
        type: 'tool',
      },
      messageId: 'assistant-1',
      sequence: 4,
      type: 'tool.updated',
    });
    expect(snapshot?.messages[0]?.version).toBe(3);

    // An upsert replacing an existing message continues the counter rather than restarting it.
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      message: {
        blocks: [{ id: 'b-0', text: '一二', type: 'text' }],
        createdAt: 1,
        id: 'assistant-1',
        role: 'assistant',
        status: 'complete',
      },
      sequence: 5,
      type: 'message.upsert',
    });
    expect(snapshot?.messages[0]?.version).toBe(4);
  });

  it('applies capability updates atomically by capability revision', () => {
    let snapshot = reduceConversationEvent(undefined, {
      ...base,
      ownerKind: 'native',
      sequence: 1,
      type: 'conversation.started',
    });
    snapshot = reduceConversationEvent(snapshot, {
      ...base,
      capabilities: {
        attachments: { image: true },
        effort: {
          applied: 'xhigh',
          options: ['low', 'medium', 'high', 'xhigh', 'max'],
          requested: 'ultracode',
          supportsUltraWorkflow: true,
        },
        evidence: 'runtime',
        fast: { state: 'confirmed' },
        model: 'claude-opus',
        permissionModes: ['default', 'plan'],
        profileKey: 'claude|official|opus',
        revision: 7,
        runtime: 'claude',
      },
      sequence: 2,
      type: 'capabilities.updated',
    });

    expect(snapshot?.capabilities).toMatchObject({
      effort: { applied: 'xhigh', requested: 'ultracode', supportsUltraWorkflow: true },
      revision: 7,
    });
  });
});
