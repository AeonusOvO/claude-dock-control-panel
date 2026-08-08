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
