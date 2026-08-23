import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeAgentProcessEnvironment,
  ClaudeAgentAdapter,
  claudeAgentExecutableFromCommand,
} from '../../src/main/claude/agent-adapter';
import type { SdkQueryFactory } from '../../src/main/claude/agent-adapter-bootstrap';
import { reduceConversationEvent } from '../../src/shared/conversation/reducer';
import type {
  ConversationEvent,
  ConversationInteraction,
} from '../../src/shared/conversation/native';

class FakeSdkQuery implements AsyncIterable<unknown> {
  public appliedSettings: Record<string, unknown>[] = [];
  public closed = false;
  public initialization: Record<string, unknown> = {
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
  };
  public interrupted = false;
  public permissionModes: string[] = [];
  public selectedModels: Array<string | undefined> = [];
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

  public setModel(model?: string): Promise<void> {
    this.selectedModels.push(model);
    return Promise.resolve();
  }

  public setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
    return Promise.resolve();
  }

  public initializationResult(): Promise<unknown> {
    return Promise.resolve(this.initialization);
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

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

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

  it('overlays and clears inherited environment keys case-insensitively', () => {
    const inherited = {
      CLAUDE_CODE_ATTRIBUTION_HEADER: 'inherited-uppercase',
      Claude_Code_Attribution_Header: 'inherited-mixed-case',
      Path: 'C:\\Windows',
    };
    const matchingKeys = (environment: NodeJS.ProcessEnv): string[] =>
      Object.keys(environment).filter(
        (key) => key.toLowerCase() === 'claude_code_attribution_header',
      );

    const gateway = buildClaudeAgentProcessEnvironment(inherited, {
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    });
    expect(matchingKeys(gateway)).toEqual(['CLAUDE_CODE_ATTRIBUTION_HEADER']);
    expect(gateway.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(gateway.Path).toBe('C:\\Windows');

    const official = buildClaudeAgentProcessEnvironment(inherited, {
      CLAUDE_CODE_ATTRIBUTION_HEADER: null,
    });
    expect(matchingKeys(official)).toEqual([]);
  });

  it('cancels a pending start before a delayed SDK factory can create a query', async () => {
    const factory = deferred<SdkQueryFactory>();
    const query = new FakeSdkQuery();
    const events: ConversationEvent[] = [];
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.13',
      queryFactory: () => factory.promise,
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    adapter.subscribe((event) => events.push(event));

    const starting = adapter.start(startInput);
    await adapter.close(startInput.conversationId);
    factory.resolve(() => query);

    await expect(starting).rejects.toThrow('Claude 原生会话启动已取消。');
    expect(query.closed).toBe(false);
    expect(events).toEqual([]);
    await expect(adapter.listCommands(startInput.conversationId)).rejects.toThrow(
      'Claude 原生会话不存在。',
    );
  });

  it('does not publish delayed initialization or close a newer exact replacement', async () => {
    const firstInitialization = deferred<unknown>();
    const firstQuery = new FakeSdkQuery();
    firstQuery.initializationResult = () => firstInitialization.promise;
    const secondQuery = new FakeSdkQuery();
    const queries = [firstQuery, secondQuery];
    const events: ConversationEvent[] = [];
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.13',
      queryFactory: async () => {
        const query = queries.shift();
        if (!query) throw new Error('Unexpected adapter start.');
        return () => query;
      },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    adapter.subscribe((event) => events.push(event));

    const firstStart = adapter.start(startInput);
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'conversation.started')).toBe(true);
    });
    await adapter.close(startInput.conversationId);
    await adapter.start(startInput);
    const replacementEventCount = events.length;

    firstInitialization.resolve({ commands: [{ name: 'stale-command' }] });
    await expect(firstStart).rejects.toThrow('Claude 原生会话启动已取消。');

    expect(firstQuery.closed).toBe(true);
    expect(secondQuery.closed).toBe(false);
    expect(events).toHaveLength(replacementEventCount);
    await expect(adapter.listCommands(startInput.conversationId)).resolves.not.toEqual([]);
    await adapter.close(startInput.conversationId);
  });

  it('passes launch-scoped settings above user and project settings', async () => {
    const query = new FakeSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    const settingsEnvironment = {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    };
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.12',
      queryFactory:
        async () =>
        ({ options }) => {
          capturedOptions = options;
          return query;
        },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });

    await adapter.start({ ...startInput, settingsEnvironment });

    expect(capturedOptions).toMatchObject({
      settingSources: ['user', 'project', 'local'],
      settings: { env: settingsEnvironment, skipWebFetchPreflight: true },
    });
    expect((capturedOptions?.settings as { env: Record<string, string> }).env).not.toBe(
      settingsEnvironment,
    );
  });

  it('asks for the Claude Code system prompt preset rather than letting it default away', async () => {
    // The SDK reads this option as `if (systemPrompt === void 0) prompt = ""` — omitting it is a
    // custom EMPTY prompt, not "use Claude Code's". Dropping this line leaves the model with the
    // full Claude Code toolset and none of the instructions for using it, which is indistinguishable
    // from the same model getting noticeably worse. Assert on the exact value, not toMatchObject
    // against a subset, so deleting the key fails loudly here instead of quietly in conversations.
    const query = new FakeSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.11',
      queryFactory:
        async () =>
        ({ options }) => {
          capturedOptions = options;
          return query;
        },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });

    await adapter.start(startInput);

    expect(capturedOptions?.systemPrompt).toEqual({ preset: 'claude_code', type: 'preset' });
    expect(capturedOptions?.tools).toEqual({ preset: 'claude_code', type: 'preset' });
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

  it('keeps the canonical model in UI state while the SDK inherits the 1M runtime suffix', async () => {
    const query = new FakeSdkQuery();
    query.initialization = {
      commands: [],
      fast_mode_state: 'off',
      models: [
        {
          resolvedModel: 'claude-opus-4-6[1m]',
          supportedEffortLevels: ['low', 'high', 'xhigh'],
          supportsFastMode: true,
          value: 'opus',
        },
        {
          resolvedModel: 'claude-sonnet-4-6[1m]',
          supportedEffortLevels: ['low', 'high'],
          supportsFastMode: false,
          value: 'sonnet',
        },
      ],
    };
    let capturedOptions: Record<string, unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.11',
      queryFactory:
        async () =>
        ({ options }) => {
          capturedOptions = options;
          return query;
        },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    await adapter.start({ ...startInput, runtimeModel: 'claude-opus-4-6[1m]' });

    expect(capturedOptions?.model).toBe('claude-opus-4-6[1m]');
    expect(events.find(({ type }) => type === 'capabilities.updated')).toMatchObject({
      capabilities: {
        model: 'claude-opus-4-6',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'claude-opus-4-6' }),
          expect.objectContaining({ id: 'claude-sonnet-4-6' }),
        ]),
      },
    });

    await adapter.updateControls(startInput.conversationId, {
      expectedCapabilityRevision: 1,
      model: 'claude-sonnet-4-6',
    });

    expect(query.selectedModels).toEqual(['claude-sonnet-4-6[1m]']);
    expect(events.at(-1)).toMatchObject({
      capabilities: {
        model: 'claude-sonnet-4-6',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'claude-opus-4-6' }),
          expect.objectContaining({ id: 'claude-sonnet-4-6' }),
        ]),
      },
      type: 'capabilities.updated',
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

  it('caps oversized tool payloads so every later snapshot stays small', async () => {
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
      message: {
        content: [
          {
            id: 'tool-1',
            input: { content: 'w'.repeat(200_000), file_path: 'D:\\big.txt' },
            name: 'Write',
            type: 'tool_use',
          },
        ],
        id: 'sdk-tool-frame',
      },
      type: 'assistant',
      uuid: 'sdk-tool-frame',
    });
    query.emit({
      message: { content: [{ tool_use_id: 'tool-1', type: 'tool_result' }] },
      tool_use_result: 'r'.repeat(500_000),
      type: 'user',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = events.reduce(
      (current, event) => reduceConversationEvent(current, event),
      undefined as ReturnType<typeof reduceConversationEvent>,
    );
    const tool = snapshot?.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool');
    expect(tool).toBeDefined();
    // The renderer re-serializes these on repaint and they ride along in every later snapshot, so
    // an untruncated multi-hundred-KB payload is what turned long sessions into a freeze.
    expect(JSON.stringify(tool?.type === 'tool' ? tool.output : '').length).toBeLessThan(40_000);
    expect(JSON.stringify(tool?.type === 'tool' ? tool.input : '').length).toBeLessThan(40_000);
    expect(String(tool?.type === 'tool' ? tool.output : '')).toContain('已省略');
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

  it('keeps explicit choice cards available in dontAsk without allowing other prompts', async () => {
    const query = new FakeSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.7',
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
    await adapter.start({ ...startInput, permissionMode: 'dontAsk' });
    expect(capturedOptions?.permissionMode).toBe('default');
    const canUseTool = capturedOptions?.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      permission: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(
      canUseTool('AskUserQuestion', { questions: [] }, { requestId: 'proactive-question' }),
    ).resolves.toMatchObject({ behavior: 'deny', message: expect.stringMatching(/明确要求/) });
    await adapter.submit(startInput.conversationId, {
      blocks: [{ text: '请解释这个选项为什么消失了。', type: 'text' }],
      clientSubmissionId: 'mentions-an-option',
    });
    await expect(
      canUseTool('AskUserQuestion', { questions: [] }, { requestId: 'mentioned-option-question' }),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await adapter.submit(startInput.conversationId, {
      blocks: [{ text: '请给我三个选项，我来选。', type: 'text' }],
      clientSubmissionId: 'explicit-choice-request',
    });
    await expect(
      canUseTool('Bash', { command: 'npm test' }, { requestId: 'unapproved-tool' }),
    ).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/未被规则预先批准/),
    });

    const decision = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            header: '实现方式',
            options: [
              { description: '修复当前链路', label: '原位修复' },
              { description: '切换为计划模式', label: '进入计划' },
            ],
            question: '你希望采用哪种方式？',
          },
        ],
      },
      { requestId: 'explicit-question', title: '请选择' },
    );
    expect(interaction).toMatchObject({ id: 'explicit-question', kind: 'question' });
    await adapter.respond(startInput.conversationId, 'explicit-question', {
      action: 'submit',
      values: { answers: { '你希望采用哪种方式？': '原位修复' } },
    });
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    await expect(
      canUseTool('AskUserQuestion', { questions: [] }, { requestId: 'second-question' }),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('exposes bypass mode only behind the project opt-in and arms the SDK before switching', async () => {
    const query = new FakeSdkQuery();
    let capturedOptions: Record<string, unknown> | undefined;
    const adapter = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.7',
      queryFactory:
        async () =>
        ({ options }) => {
          capturedOptions = options;
          return query;
        },
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    const events: ConversationEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start({ ...startInput, allowBypassPermissions: true });

    expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(true);
    expect(events.find((event) => event.type === 'capabilities.updated')).toMatchObject({
      capabilities: { permissionModes: expect.arrayContaining(['bypassPermissions']) },
    });
    await adapter.updateControls(startInput.conversationId, {
      expectedCapabilityRevision: 1,
      permissionMode: 'bypassPermissions',
    });
    expect(query.permissionModes).toEqual(['bypassPermissions']);

    const blocked = new ClaudeAgentAdapter({
      appVersion: '5.0.0-rc.7',
      queryFactory: async () => () => new FakeSdkQuery(),
      resolveExecutable: async () => 'C:\\Claude\\claude.exe',
    });
    await expect(
      blocked.start({ ...startInput, permissionMode: 'bypassPermissions' }),
    ).rejects.toThrow(/关闭了「完全允许」预置/);
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
