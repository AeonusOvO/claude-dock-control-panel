import type {
  ConversationAdapter,
  ConversationControlUpdate,
  ConversationCommandView,
  ConversationEvent,
  ConversationInteractionResponse,
  ConversationStartInput,
  ConversationSubmitInput,
  ConversationTaskView,
} from '../../shared/conversation/native';
import { CLAUDE_NATIVE_COMMANDS } from '../../shared/claude/native-commands';

interface FakeSession {
  capabilityRevision: number;
  effort: string;
  fast: boolean;
  input: ConversationStartInput;
  interactions: Set<string>;
  model: string;
  permissionMode: string;
  revision: number;
  sequence: number;
  tasks: ConversationTaskView[];
}

type FakeEventBody<T = ConversationEvent> = T extends ConversationEvent
  ? Omit<T, 'conversationId' | 'emittedAt' | 'projectPath' | 'revision' | 'runtime' | 'sequence'>
  : never;

/** Deterministic, network-free adapter used only by isolated integration and visual fixtures. */
export class FakeConversationAdapter implements ConversationAdapter {
  private readonly listeners = new Set<(event: ConversationEvent) => void>();
  private readonly sessions = new Map<string, FakeSession>();

  public subscribe(listener: (event: ConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async start(input: ConversationStartInput): Promise<void> {
    const existing = this.sessions.get(input.conversationId);
    const session: FakeSession = {
      capabilityRevision: 1,
      effort: 'ultracode',
      fast: true,
      input,
      interactions: new Set(),
      model: input.model ?? 'claude-opus-4-6',
      permissionMode: input.permissionMode ?? 'default',
      revision: (existing?.revision ?? 0) + 1,
      sequence: 0,
      tasks: [],
    };
    this.sessions.set(input.conversationId, session);
    this.emit(session, { ownerKind: input.ownerKind, type: 'conversation.started' });
    this.publishCapabilities(session);
    this.emit(session, { commands: CLAUDE_NATIVE_COMMANDS, type: 'commands.updated' });
    this.emit(session, { phase: 'idle', type: 'conversation.phase' });
  }

  private publishCapabilities(session: FakeSession): void {
    this.emit(session, {
      capabilities: {
        attachments: { image: true },
        effort: {
          applied: session.effort === 'ultracode' ? 'xhigh' : session.effort,
          options: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
          requested: session.effort,
          supportsUltraWorkflow: true,
        },
        evidence: 'isolated-probe',
        fast: { state: session.fast ? 'requested' : 'off' },
        model: session.model,
        models: [
          {
            attachments: { image: true },
            effortOptions: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
            id: 'claude-opus-4-6',
            label: 'Claude Opus 4.6',
            supportsFast: true,
            supportsUltraWorkflow: true,
          },
          {
            attachments: { image: true },
            effortOptions: ['auto', 'low', 'medium', 'high'],
            id: 'claude-haiku-4-5',
            label: 'Claude Haiku 4.5',
            supportsFast: false,
            supportsUltraWorkflow: false,
          },
        ],
        permissionModes: [
          'default',
          'acceptEdits',
          'plan',
          ...(session.input.allowBypassPermissions ? ['bypassPermissions'] : []),
          'auto',
          'dontAsk',
        ],
        profileKey: 'fake|claude|visual-fixture',
        revision: session.capabilityRevision,
        runtime: 'claude',
        verifiedAt: Date.now(),
      },
      type: 'capabilities.updated',
    });
  }

  public async updateControls(
    conversationId: string,
    update: ConversationControlUpdate,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    if (update.expectedCapabilityRevision !== session.capabilityRevision) {
      throw new Error('模型能力已经变化，请按最新选项重试。');
    }
    const selected = update.model ?? session.model;
    const limited = selected.includes('haiku');
    if (update.effort && limited && !['auto', 'low', 'medium', 'high'].includes(update.effort)) {
      throw new Error('当前模型不支持这个思考档位。');
    }
    session.model = selected;
    session.effort = update.effort ?? (limited ? 'high' : session.effort);
    session.fast = update.fast ?? (limited ? false : session.fast);
    session.permissionMode = update.permissionMode ?? session.permissionMode;
    session.capabilityRevision += 1;
    this.publishCapabilities(session);
  }

  public async submit(conversationId: string, input: ConversationSubmitInput): Promise<void> {
    const session = this.requireSession(conversationId);
    const text = input.blocks
      .filter((block): block is Extract<(typeof input.blocks)[number], { type: 'text' }> =>
        Boolean(block.type === 'text'),
      )
      .map((block) => block.text)
      .join('\n');
    this.emit(session, { phase: 'running', type: 'conversation.phase' });
    this.emit(session, {
      message: {
        blocks: input.blocks.map((block, index) =>
          block.type === 'text'
            ? {
                id: `${input.clientSubmissionId}:${index}`,
                text: block.text,
                type: 'text' as const,
              }
            : {
                id: `${input.clientSubmissionId}:${index}`,
                mediaType: block.attachment.mediaType,
                name: block.attachment.name,
                source: block.attachment.path ?? block.attachment.id,
                type: 'image' as const,
              },
        ),
        createdAt: Date.now(),
        id: input.clientSubmissionId,
        role: 'user',
        status: 'complete',
      },
      type: 'message.upsert',
    });
    if (text.includes('[fixture:hold]')) {
      // Park the conversation in `running` with no assistant output at all. Real-window QA needs a
      // turn it can photograph mid-flight: the send button's stop state, the halo it grows on click
      // and the queued bar only exist while a turn is genuinely in progress, and every other fake
      // response resolves inside the same tick. `interrupt` releases it back to `idle`.
      this.emit(session, {
        clientSubmissionId: input.clientSubmissionId,
        type: 'submission.transcript-confirmed',
      });
      return;
    }
    const assistantId = `fake-assistant-${input.clientSubmissionId}`;
    this.emit(session, {
      blockId: `${assistantId}:0`,
      blockType: 'text',
      delta: `收到：${text}\n\n`,
      messageId: assistantId,
      type: 'message.delta',
    });
    this.emit(session, {
      blockId: `${assistantId}:0`,
      blockType: 'text',
      delta: '这是隔离适配器生成的 **保真 Markdown**。\n\n```ts\nconst safe = true;\n```',
      messageId: assistantId,
      type: 'message.delta',
    });
    this.emit(session, {
      message: {
        blocks: [
          {
            id: `${assistantId}:0`,
            text: `收到：${text}\n\n这是隔离适配器生成的 **保真 Markdown**。\n\n\`\`\`ts\nconst safe = true;\n\`\`\``,
            type: 'text',
          },
        ],
        createdAt: Date.now(),
        id: assistantId,
        role: 'assistant',
        status: 'complete',
      },
      type: 'message.upsert',
    });
    this.emit(session, {
      clientSubmissionId: input.clientSubmissionId,
      type: 'submission.transcript-confirmed',
    });
    if (text.includes('[fixture:full]')) {
      this.publishFullFixture(session, input.clientSubmissionId, assistantId);
    } else {
      this.emit(session, { phase: 'idle', type: 'conversation.phase' });
    }
  }

  public async interrupt(conversationId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    this.emit(session, { phase: 'idle', type: 'conversation.phase' });
  }

  public async stopTask(conversationId: string, taskId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    session.tasks = session.tasks.map((task) =>
      task.id === taskId && task.cancellable
        ? { ...task, status: 'stopped' as const, updatedAt: Date.now() }
        : task,
    );
    this.emit(session, { tasks: session.tasks, type: 'tasks.reconciled' });
  }

  public async respond(
    conversationId: string,
    interactionId: string,
    _response: ConversationInteractionResponse,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    session.interactions.delete(interactionId);
    this.emit(session, { interactionId, type: 'interaction.resolved' });
    if (session.interactions.size === 0) {
      this.emit(session, { phase: 'idle', type: 'conversation.phase' });
    }
  }

  public async listCommands(conversationId: string): Promise<ConversationCommandView[]> {
    this.requireSession(conversationId);
    return CLAUDE_NATIVE_COMMANDS.map((command) => ({ ...command, aliases: [...command.aliases] }));
  }

  public async close(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    this.emit(session, { phase: 'stopped', type: 'conversation.phase' });
    this.sessions.delete(conversationId);
  }

  private requireSession(conversationId: string): FakeSession {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error('隔离对话不存在。');
    return session;
  }

  private publishFullFixture(
    session: FakeSession,
    submissionId: string,
    assistantId: string,
  ): void {
    this.emit(session, {
      block: {
        id: `${assistantId}:tool-read`,
        input: { path: 'src/main/main.ts' },
        name: 'Read',
        output: '已读取 120 行。',
        status: 'succeeded',
        summary: '读取原生会话入口',
        type: 'tool',
      },
      messageId: assistantId,
      type: 'tool.updated',
    });
    this.emit(session, {
      block: {
        id: `${assistantId}:tool-edit`,
        input: { path: 'package.json' },
        name: 'Edit',
        output: '隔离场景故意模拟权限不足；未写入文件。',
        status: 'failed',
        summary: '更新发布配置',
        type: 'tool',
      },
      messageId: assistantId,
      type: 'tool.updated',
    });
    session.tasks = [
      {
        cancellable: true,
        description: '检查四主题与响应式布局',
        id: `${submissionId}:task-running`,
        kind: 'subagent',
        status: 'running',
        summary: '视觉检查进行中',
        updatedAt: Date.now(),
      },
      {
        cancellable: false,
        description: '核对结构化事件顺序',
        id: `${submissionId}:task-complete`,
        kind: 'workflow',
        status: 'completed',
        summary: '已完成',
        updatedAt: Date.now(),
      },
    ];
    this.emit(session, { tasks: session.tasks, type: 'tasks.reconciled' });
    this.emit(session, {
      type: 'usage.updated',
      usage: { durationMs: 1_840, inputTokens: 312, outputTokens: 428 },
    });

    const interactions = [
      {
        allowRemember: true,
        createdAt: Date.now(),
        description: '只在隔离项目中模拟，不会修改真实文件。',
        id: `${submissionId}:permission`,
        input: { file: 'package.json', tool: 'Edit' },
        kind: 'permission' as const,
        title: '允许修改发布配置吗？',
        toolName: 'Edit',
        toolUseId: `${submissionId}:tool-edit`,
      },
      {
        createdAt: Date.now(),
        id: `${submissionId}:question`,
        kind: 'question' as const,
        questions: [
          {
            header: '恢复策略',
            multiSelect: false,
            options: [
              {
                description: '聚焦已经运行的 owner，不重复启动。',
                label: '保留现有会话',
              },
              {
                description: '安全停止旧 owner 后再精确恢复 UUID。',
                label: '替换旧 owner',
              },
            ],
            question: '检测到同一对话已经运行时怎么办？',
          },
        ],
        title: '选择异常恢复策略',
      },
      {
        approvalModes: ['allow', 'deny'],
        createdAt: Date.now(),
        id: `${submissionId}:plan`,
        kind: 'plan' as const,
        markdown:
          '# 发布前计划检查\n\n1. 结构化适配器与单一 owner\n2. 恢复日志与图片安全\n3. 四主题视觉矩阵\n4. 完整测试、打包和发布审计\n\n> 不确定状态绝不自动重发。',
        title: 'ClaudeDock 5.0 原生对话实施计划',
      },
      {
        createdAt: Date.now(),
        description: '结构化 MCP 表单只会把显式填写的字段交给当前请求。',
        id: `${submissionId}:mcp`,
        kind: 'mcp' as const,
        mode: 'form' as const,
        schema: {
          properties: {
            query: {
              description: '输入要核验的主题',
              title: '查询内容',
              type: 'string',
            },
          },
          required: ['query'],
          type: 'object',
        },
        title: 'MCP 需要补充信息',
      },
    ];
    for (const interaction of interactions) {
      session.interactions.add(interaction.id);
      this.emit(session, { interaction, type: 'interaction.requested' });
    }
  }

  private emit(session: FakeSession, event: FakeEventBody): void {
    const complete = {
      ...event,
      conversationId: session.input.conversationId,
      emittedAt: Date.now(),
      projectPath: session.input.projectPath,
      revision: session.revision,
      runtime: 'claude' as const,
      sequence: ++session.sequence,
    } as ConversationEvent;
    for (const listener of this.listeners) listener(complete);
  }
}
