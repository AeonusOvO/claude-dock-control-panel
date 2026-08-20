import { describe, expect, it } from 'vitest';
import { FakeConversationAdapter } from '../../src/main/conversation/fake-adapter';
import { reduceConversationEvent } from '../../src/shared/conversation/reducer';
import type { ConversationEvent, ConversationSnapshot } from '../../src/shared/conversation/native';

describe('fake conversation adapter', () => {
  it('runs a complete network-free streaming turn for visual fixtures', async () => {
    const adapter = new FakeConversationAdapter();
    let snapshot: ConversationSnapshot | undefined;
    adapter.subscribe((event: ConversationEvent) => {
      snapshot = reduceConversationEvent(snapshot, event);
    });
    const conversationId = '11111111-1111-4111-8111-111111111111';
    await adapter.start({
      conversationId,
      ownerKind: 'native',
      projectPath: 'D:\\Fixtures\\Project',
      resume: false,
    });
    await adapter.submit(conversationId, {
      blocks: [{ text: '保留\n\n空白', type: 'text' }],
      clientSubmissionId: 'submit-1',
    });

    expect(snapshot?.phase).toBe('idle');
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.messages[1]?.blocks[0]).toMatchObject({
      text: expect.stringContaining('```ts'),
      type: 'text',
    });
    expect(snapshot?.capabilities?.effort).toMatchObject({
      applied: 'xhigh',
      requested: 'ultracode',
    });
  });

  it('covers tools, images, permissions, questions, plans, MCP, tasks and usage offline', async () => {
    const adapter = new FakeConversationAdapter();
    let snapshot: ConversationSnapshot | undefined;
    adapter.subscribe((event: ConversationEvent) => {
      snapshot = reduceConversationEvent(snapshot, event);
    });
    const conversationId = '22222222-2222-4222-8222-222222222222';
    await adapter.start({
      conversationId,
      ownerKind: 'native',
      projectPath: 'D:\\Fixtures\\Full',
      resume: false,
    });
    await adapter.submit(conversationId, {
      blocks: [
        { text: '[fixture:full] 检查完整交互', type: 'text' },
        {
          attachment: {
            id: 'image-1',
            mediaType: 'image/png',
            name: 'fixture.png',
            path: 'D:\\Fixtures\\fixture.png',
            size: 1_024,
          },
          type: 'image',
        },
      ],
      clientSubmissionId: 'submit-full',
    });

    expect(snapshot?.phase).toBe('requires-action');
    expect(snapshot?.messages[0]?.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'fixture.png', type: 'image' })]),
    );
    expect(snapshot?.messages[1]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Read', status: 'succeeded', type: 'tool' }),
        expect.objectContaining({ name: 'Edit', status: 'failed', type: 'tool' }),
      ]),
    );
    expect(snapshot?.interactions.map(({ kind }) => kind)).toEqual([
      'permission',
      'question',
      'plan',
      'mcp',
    ]);
    expect(snapshot?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cancellable: true, kind: 'subagent', status: 'running' }),
        expect.objectContaining({ kind: 'workflow', status: 'completed' }),
      ]),
    );
    expect(snapshot?.usage).toMatchObject({ inputTokens: 312, outputTokens: 428 });

    await adapter.stopTask(conversationId, 'submit-full:task-running');
    expect(snapshot?.tasks[0]?.status).toBe('stopped');
    for (const interaction of [...(snapshot?.interactions ?? [])]) {
      await adapter.respond(conversationId, interaction.id, { action: 'cancel' });
    }
    expect(snapshot?.interactions).toHaveLength(0);
    expect(snapshot?.phase).toBe('idle');
  });
});
