import { describe, expect, it } from 'vitest';
import { ClaudeAgentAdapter } from '../src/main/claude-agent-adapter';
import type { ConversationEvent, ConversationInteraction } from '../src/shared/native-conversation';

class FakeSdkQuery implements AsyncIterable<unknown> {
  public appliedSettings: Record<string, unknown>[] = [];
  public closed = false;
  public interrupted = false;
  public stoppedTasks: string[] = [];
  private readonly pending: Array<(value: IteratorResult<unknown>) => void> = [];
  private readonly values: unknown[] = [];

  public emit(value: unknown): void {
    const resolve = this.pending.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
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
    for (const resolve of this.pending.splice(0)) resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.pending.push(resolve));
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
