import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeAgentAdapter,
  claudeAgentExecutableFromCommand,
} from '../src/main/claude-agent-adapter';
import { reduceConversationEvent } from '../src/shared/conversation-reducer';
import type { ConversationEvent, ConversationInteraction } from '../src/shared/native-conversation';

class FakeSdkQuery implements AsyncIterable<unknown> {
  public appliedSettings: Record<string, unknown>[] = [];
  public closed = false;
  public interrupted = false;
  public stoppedTasks: string[] = [];
  private failure?: Error;
  private readonly pending: Array<{
    reject: (error: Error) => void;
    resolve: (value: IteratorResult<unknown>) => void;
  }> = [];
  private readonly values: unknown[] = [];

  public emit(value: unknown): void {
    const pending = this.pending.shift();
    if (pending) pending.resolve({ done: false, value });
    else this.values.push(value);
  }

  public fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  public applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.appliedSettings.push(settings);
    return Promise.resolve();
  }

  public setModel(_model?: string): Promise<void> {
    return Promise.resolve();
  }

  public setPermissionMode(_mode: string): Promise<void> {
    return Promise.resolve();
  }

  public initializationResult(): Promise<unknown> {
    return Promise.resolve({
      commands: [
        { aliases: [], argumentHint: '', description: '帮助', name: 'help' },
        { aliases: [], argumentHint: '', description: 'future', name: 'future-command' },
      ],
      fast_mode_state: 'on',
      models: [
        {
          resolvedModel: 'claude-opus-4-6',
          supportedEffortLevels: ['low', 'high', 'xhigh', 'max'],
          supportsFastMode: true,
          value: 'opus',
        },
      ],
    });
  }

  public interrupt(): Promise<unknown> {
    this.interrupted = true;
    return Promise.resolve({});
  }

  public stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
    return Promise.resolve();
  }

  public supportedCommands(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  public close(): void {
    this.closed = true;
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.failure) throw this.failure;
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve, reject) => this.pending.push({ reject, resolve }));
      },
    };
  }
}

const startInput = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  model: 'claude-opus-4-6',
  ownerKind: 'native' as const,
  permissionMode: 'default',
  projectPath: 'D:\\Fixtures\\Project',
  resume: false,
};

describe('Claude Agent SDK adapter', () => {
  it('unwraps the NPM command shim to the user-installed native Claude executable', () => {
    const shim = 'C:\\Users\\Example\\AppData\\Roaming\\npm\\claude.ps1';
    const expected = path.join(
      path.dirname(shim),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );

    expect(claudeAgentExecutableFromCommand(shim, (candidate) => candidate === expected)).toBe(
      expected,
    );
  });

  it('rejects an incomplete NPM Claude installation with a repairable explanation', () => {
    expect(() =>
      claudeAgentExecutableFromCommand(
        'C:\\Users\\Example\\AppData\\Roaming\\npm\\claude.cmd',
        () => false,
      ),
    ).toThrow(/NPM.*claude\.exe.*重新安装 Claude Code/);
  });

  it('uses the explicitly resolved local executable and emits runtime capabilities', async () => {
    const query = new FakeSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.1',
      queryFactory:
        async () =>
        ({ options }) => {
          capturedOptions = options;
          return query;
        },
      resolveExecutable: async () => 'C:\\Users\\Example\\.local\\bin\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start(startInput);

    expect(capturedOptions?.pathToClaudeCodeExecutable).toBe(
      'C:\\Users\\Example\\.local\\bin\\claude.exe',
    );
    expect(capturedOptions).toMatchObject({
      persistSession: true,
      sessionId: startInput.conversationId,
    });
    expect(events.find(({ type }) => type === 'capabilities.updated')).toMatchObject({
      capabilities: {
        evidence: 'runtime',
        fast: { state: 'confirmed' },
        model: 'claude-opus-4-6',
      },
    });
  });

  it('blocks unknown and locally mapped slash commands before SDK input', async () => {
    const query = new FakeSdkQuery();
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.1',
      queryFactory: async () => () => query,
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    await adapter.start(startInput);
    await expect(
      adapter.submit(startInput.conversationId, {
        blocks: [{ text: '/future-command', type: 'text' }],
        clientSubmissionId: 'submit-1',
      }),
    ).rejects.toThrow(/未知命令/);
    await expect(
      adapter.submit(startInput.conversationId, {
        blocks: [{ text: '/model', type: 'text' }],
        clientSubmissionId: 'submit-2',
      }),
    ).rejects.toThrow(/页面/);
  });

  it('writes an accepted submission into the SDK stream and immediately publishes the user row', async () => {
    const query = new FakeSdkQuery();
    let prompt: AsyncIterable<unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.5',
      queryFactory: async () => (input) => {
        prompt = input.prompt;
        return query;
      },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start(startInput);
    const submission = {
      blocks: [{ text: '发送链路回归', type: 'text' as const }],
      clientSubmissionId: 'submit-visible-1',
    };

    await adapter.submit(startInput.conversationId, submission);

    await expect(prompt![Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: {
        message: { content: [{ text: '发送链路回归', type: 'text' }], role: 'user' },
        parent_tool_use_id: null,
        type: 'user',
        uuid: submission.clientSubmissionId,
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          id: submission.clientSubmissionId,
          role: 'user',
          status: 'complete',
        }),
        type: 'message.upsert',
      }),
    );
    expect(events.at(-1)).toMatchObject({ phase: 'running', type: 'conversation.phase' });
  });

  it('coalesces UUID-less token deltas and the final assistant frame into one message', async () => {
    const query = new FakeSdkQuery();
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.6',
      queryFactory: async () => () => query,
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start(startInput);

    query.emit({
      event: { delta: { text: '你', type: 'text_delta' }, index: 0, type: 'content_block_delta' },
      type: 'stream_event',
    });
    query.emit({
      event: { delta: { text: '好', type: 'text_delta' }, index: 0, type: 'content_block_delta' },
      type: 'stream_event',
    });
    query.emit({
      message: {
        content: [{ text: '你好', type: 'text' }],
        id: 'sdk-final-message',
      },
      type: 'assistant',
      uuid: 'sdk-final-frame',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const assistantEvents = events.filter(
      (event) => event.type === 'message.delta' || event.type === 'message.upsert',
    );
    const streamedIds = assistantEvents.flatMap((event) =>
      event.type === 'message.delta'
        ? [event.messageId]
        : event.message.role === 'assistant'
          ? [event.message.id]
          : [],
    );
    expect([...new Set(streamedIds)]).toHaveLength(1);

    const snapshot = events.reduce(
      (current, event) => reduceConversationEvent(current, event),
      undefined as ReturnType<typeof reduceConversationEvent>,
    );
    expect(snapshot?.messages).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ text: '你好', type: 'text' })],
        role: 'assistant',
        status: 'complete',
      }),
    ]);
  });

  it('keeps the SDK stream reusable after a failed turn and renders the failure', async () => {
    const query = new FakeSdkQuery();
    let prompt: AsyncIterable<unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.5',
      queryFactory: async () => (input) => {
        prompt = input.prompt;
        return query;
      },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start(startInput);
    const iterator = prompt![Symbol.asyncIterator]();
    await adapter.submit(startInput.conversationId, {
      blocks: [{ text: '第一次', type: 'text' }],
      clientSubmissionId: 'submit-failed-turn',
    });
    await iterator.next();

    query.emit({
      errors: ['本轮请求被上游拒绝'],
      is_error: true,
      type: 'result',
      user_message_uuid: 'submit-failed-turn',
      uuid: 'result-failed-turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ role: 'system', status: 'failed' }),
        type: 'message.upsert',
      }),
    );
    expect(events.at(-1)).toMatchObject({ phase: 'idle', type: 'conversation.phase' });
    await expect(
      adapter.submit(startInput.conversationId, {
        blocks: [{ text: '修正后重试', type: 'text' }],
        clientSubmissionId: 'submit-retry-turn',
      }),
    ).resolves.toBeUndefined();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { uuid: 'submit-retry-turn' },
    });
  });

  it('tears down a dead SDK stream so later sends fail instead of entering a black hole', async () => {
    const query = new FakeSdkQuery();
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.5',
      queryFactory: async () => () => query,
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start(startInput);

    query.fail(new Error('SDK transport exited'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.at(-1)).toMatchObject({
      message: 'SDK transport exited',
      type: 'conversation.error',
    });
    await expect(
      adapter.submit(startInput.conversationId, {
        blocks: [{ text: '不能进入死亡队列', type: 'text' }],
        clientSubmissionId: 'submit-after-fatal',
      }),
    ).rejects.toThrow('原生会话不存在');
  });

  it('surfaces permission requests and only resolves them from the native interaction queue', async () => {
    const query = new FakeSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.1',
      queryFactory:
        async () =>
        ({ options }) => {
          capturedOptions = options;
          return query;
        },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    let interaction: ConversationInteraction | undefined;
    adapter.subscribe((event) => {
      if (event.type === 'interaction.requested') interaction = event.interaction;
    });
    await adapter.start(startInput);
    const canUseTool = capturedOptions?.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      permission: Record<string, unknown>,
    ) => Promise<unknown>;
    const decision = canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        requestId: 'permission-1',
        suggestions: [{ behavior: 'allow', type: 'addRules' }],
        title: '允许运行测试？',
        toolUseID: 'tool-1',
      },
    );
    expect(interaction).toMatchObject({ id: 'permission-1', kind: 'permission' });
    await adapter.respond(startInput.conversationId, 'permission-1', {
      action: 'allow',
      remember: true,
    });
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('uses authoritative empty background snapshots to clear running tasks', async () => {
    const query = new FakeSdkQuery();
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.1',
      queryFactory: async () => () => query,
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const taskEvents: ConversationEvent[] = [];
    adapter.subscribe((event) => {
      if (event.type === 'tasks.reconciled') taskEvents.push(event);
    });
    await adapter.start(startInput);
    query.emit({
      session_id: startInput.conversationId,
      subtype: 'background_tasks_changed',
      tasks: [{ description: '搜索资料', task_id: 'task-1', task_type: 'web' }],
      type: 'system',
      uuid: 'event-1',
    });
    query.emit({
      session_id: startInput.conversationId,
      subtype: 'background_tasks_changed',
      tasks: [],
      type: 'system',
      uuid: 'event-2',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(taskEvents.at(-1)).toMatchObject({
      tasks: [{ id: 'task-1', status: 'lost' }],
    });
  });
});
