import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  mergeRuntimeClaudeCommands,
  resolveClaudeNativeCommand,
} from '../shared/claude-native-commands';
import type {
  ConversationAdapter,
  ConversationControlUpdate,
  ConversationCommandView,
  ConversationContentBlock,
  ConversationEvent,
  ConversationInteraction,
  ConversationInteractionResponse,
  ConversationStartInput,
  ConversationSubmitInput,
  ConversationTaskView,
  ModelCapabilityProfile,
} from '../shared/native-conversation';
import { resolveWindowsCommand } from './windows-command';

type AgentEventBody<T = ConversationEvent> = T extends ConversationEvent
  ? Omit<T, 'conversationId' | 'emittedAt' | 'projectPath' | 'revision' | 'runtime' | 'sequence'>
  : never;

interface SdkQuery extends AsyncIterable<unknown> {
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  close(): void;
  initializationResult(): Promise<unknown>;
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  supportedCommands(): Promise<unknown[]>;
}

type SdkQueryFactory = (input: {
  options: Record<string, unknown>;
  prompt: AsyncIterable<unknown>;
}) => SdkQuery;

interface PendingInteraction {
  abort: () => void;
  complete: (response: ConversationInteractionResponse) => void;
}

interface ToolLocation {
  block: Extract<ConversationContentBlock, { type: 'tool' }>;
  messageId: string;
}

interface AgentSession {
  allowQuestionInteraction: boolean;
  assistantStreamSequence: number;
  assistantStreams: Map<string, string>;
  capabilityRevision: number;
  commands: ConversationCommandView[];
  effort?: string;
  fast: boolean;
  input: ConversationStartInput;
  initialization: Record<string, unknown>;
  interactions: Map<string, PendingInteraction>;
  model?: string;
  models: Record<string, unknown>[];
  permissionMode: string;
  query: SdkQuery;
  queue: AsyncInputQueue;
  revision: number;
  sequence: number;
  tasks: Map<string, ConversationTaskView>;
  tools: Map<string, ToolLocation>;
}

export interface ClaudeAgentAdapterOptions {
  appVersion: string;
  environment?: (input: ConversationStartInput) => Record<string, null | string | undefined>;
  queryFactory?: () => Promise<SdkQueryFactory>;
  resolveExecutable?: (cwd: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  startTimeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const arrayValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

class AsyncInputQueue implements AsyncIterable<unknown> {
  private closed = false;
  private readonly pending: Array<(result: IteratorResult<unknown>) => void> = [];
  private readonly values: unknown[] = [];

  public push(value: unknown): void {
    if (this.closed) throw new Error('原生会话输入通道已关闭。');
    const resolve = this.pending.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
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
        return new Promise<IteratorResult<unknown>>((resolve) => this.pending.push(resolve));
      },
    };
  }
}

const defaultQueryFactory = async (): Promise<SdkQueryFactory> => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as SdkQueryFactory;
};

export const claudeAgentExecutableFromCommand = (
  resolvedCommand: string,
  fileExists: (candidate: string) => boolean = existsSync,
): string => {
  const basename = path.basename(resolvedCommand).toLowerCase();
  if (basename === 'claude.exe') return resolvedCommand;
  if (!['claude', 'claude.cmd', 'claude.ps1'].includes(basename)) {
    throw new Error('本机 Claude Code 命令不是受支持的 Windows 启动器。');
  }
  const npmExecutable = path.join(
    path.dirname(resolvedCommand),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  if (!fileExists(npmExecutable)) {
    throw new Error(
      '已找到 NPM 的 Claude Code 启动器，但没有找到它安装的 claude.exe。请在“任务与下载”中重新安装 Claude Code。',
    );
  }
  return npmExecutable;
};

const defaultResolveExecutable = async (
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> => {
  if (process.platform !== 'win32') {
    throw new Error('ClaudeDock 目前只在 Windows 上提供原生 Claude 会话。');
  }
  // NPM exposes `claude.ps1`/`claude.cmd` on PATH while the native executable lives inside the
  // installed package. Resolve that user-owned executable explicitly so the Agent SDK uses the
  // same Claude Code installation without bundling or silently falling back to a second copy.
  return claudeAgentExecutableFromCommand(await resolveWindowsCommand('claude', environment, cwd));
};

const commandRecords = (
  value: unknown,
): Array<{
  aliases?: readonly string[];
  argumentHint?: string;
  description?: string;
  name: string;
}> =>
  arrayValue(value).flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return [];
    return [
      {
        aliases: Array.isArray(item.aliases)
          ? item.aliases.filter((alias): alias is string => typeof alias === 'string')
          : undefined,
        argumentHint: stringValue(item.argumentHint),
        description: stringValue(item.description),
        name: item.name,
      },
    ];
  });

const normalizedPermissionMode = (value: string | undefined): string =>
  ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(value ?? '')
    ? value!
    : 'default';

// Upstream `dontAsk` denies AskUserQuestion before the SDK's canUseTool callback, even when the
// user explicitly asked for a choice card. ClaudeDock keeps the same deny-by-default policy in its
// callback while running the SDK permission engine in `default`, then makes a narrow exception for
// an explicitly requested structured question.
const sdkPermissionMode = (value: string): string => (value === 'dontAsk' ? 'default' : value);

const EXPLICIT_QUESTION_REQUESTS = [
  /AskUserQuestion|(?:帮我|给我|让我|供我|我来).{0,16}(?:选择题|选项|选择|选)|(?:列出|展示|显示|生成|出).{0,12}(?:选择题|选项|方案).{0,12}(?:选择|选)?/iu,
  /\b(?:multiple[- ]choice|give me (?:some )?(?:options|choices)|let me choose|ask me (?:a |some )?questions?|present (?:me )?with (?:options|choices))\b/iu,
];
const EXPLICIT_QUESTION_REJECTIONS = [
  /(?:不要|不用|无需|别).{0,12}(?:选择题|选项|提问|问我|询问)/u,
  /\b(?:do not|don't|no need to).{0,24}(?:ask|options|choices|questions)\b/iu,
];

const explicitlyRequestsQuestionInteraction = (input: ConversationSubmitInput): boolean =>
  input.blocks.some(
    (block) =>
      block.type === 'text' &&
      !EXPLICIT_QUESTION_REJECTIONS.some((pattern) => pattern.test(block.text)) &&
      EXPLICIT_QUESTION_REQUESTS.some((pattern) => pattern.test(block.text)),
  );

export class ClaudeAgentAdapter implements ConversationAdapter {
  private readonly listeners = new Set<(event: ConversationEvent) => void>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly startRevisions = new Map<string, number>();

  public constructor(private readonly options: ClaudeAgentAdapterOptions) {}

  public subscribe(listener: (event: ConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async start(input: ConversationStartInput): Promise<void> {
    if (this.sessions.has(input.conversationId))
      throw new Error('该 Claude 会话已经在原生界面运行。');
    const permissionMode = normalizedPermissionMode(input.permissionMode);
    if (permissionMode === 'bypassPermissions' && input.allowBypassPermissions !== true) {
      throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
    }
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(this.options.environment?.(input) ?? {})) {
      if (value === null || value === undefined) delete environment[name];
      else environment[name] = value;
    }
    environment.CLAUDE_AGENT_SDK_CLIENT_APP = `ClaudeDock/${this.options.appVersion}`;
    environment.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
    delete environment.ELECTRON_RUN_AS_NODE;
    const [factory, executable] = await Promise.all([
      (this.options.queryFactory ?? defaultQueryFactory)(),
      (this.options.resolveExecutable ?? defaultResolveExecutable)(input.projectPath, environment),
    ]);
    const queue = new AsyncInputQueue();
    const revision = (this.startRevisions.get(input.conversationId) ?? 0) + 1;
    this.startRevisions.set(input.conversationId, revision);
    const sessionReference: { current?: AgentSession } = {};
    const requireSession = (): AgentSession => {
      if (!sessionReference.current) throw new Error('Claude 原生会话尚未完成初始化。');
      return sessionReference.current;
    };
    const adapterOptions: Record<string, unknown> = {
      agentProgressSummaries: true,
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>,
        permission: Record<string, unknown>,
      ) => this.requestToolPermission(requireSession(), toolName, toolInput, permission),
      cwd: input.projectPath,
      env: environment,
      includeHookEvents: true,
      includePartialMessages: true,
      model: input.model,
      onElicitation: async (request: Record<string, unknown>, context: { signal: AbortSignal }) =>
        this.requestElicitation(requireSession(), request, context.signal),
      pathToClaudeCodeExecutable: executable,
      permissionMode: sdkPermissionMode(permissionMode),
      persistSession: true,
      settingSources: ['user', 'project', 'local'],
      tools: { preset: 'claude_code', type: 'preset' },
    };
    if (input.allowBypassPermissions === true) {
      adapterOptions.allowDangerouslySkipPermissions = true;
    }
    if (input.resume) adapterOptions.resume = input.conversationId;
    else adapterOptions.sessionId = input.conversationId;
    const query = factory({ options: adapterOptions, prompt: queue });
    const session: AgentSession = {
      allowQuestionInteraction: false,
      assistantStreamSequence: 0,
      assistantStreams: new Map(),
      capabilityRevision: 0,
      commands: [],
      fast: false,
      input,
      initialization: {},
      interactions: new Map(),
      model: input.model,
      models: [],
      permissionMode,
      query,
      queue,
      revision,
      sequence: 0,
      tasks: new Map(),
      tools: new Map(),
    };
    sessionReference.current = session;
    this.sessions.set(input.conversationId, session);
    this.emit(session, { ownerKind: input.ownerKind, type: 'conversation.started' });
    const consume = this.consume(session);
    const timeoutMs = this.options.startTimeoutMs ?? 30_000;
    try {
      const initialization = await Promise.race([
        query.initializationResult(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Claude 原生会话在 ${timeoutMs} 毫秒内没有完成初始化。`)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
      await this.publishInitialization(session, initialization);
      this.emit(session, { phase: 'idle', type: 'conversation.phase' });
      void consume;
    } catch (error) {
      await this.close(input.conversationId);
      throw error;
    }
  }

  public async submit(conversationId: string, input: ConversationSubmitInput): Promise<void> {
    const session = this.requireSession(conversationId);
    const textBlocks = input.blocks.filter((block) => block.type === 'text');
    const commandText =
      input.blocks.length === 1 && textBlocks.length === 1 ? textBlocks[0]!.text.trim() : '';
    if (commandText.startsWith('/')) {
      const command = resolveClaudeNativeCommand(commandText);
      if (!command)
        throw new Error('这是新版未知命令，已阻止作为普通提示词发送。请先兼容检测或进入高级终端。');
      if (command.mapping !== 'adapter') {
        throw new Error(
          `命令 ${command.name} 应由 ClaudeDock 的${this.mappingLabel(command.mapping)}处理。`,
        );
      }
      const supported = new Set(
        session.commands.flatMap((candidate) => [candidate.name, ...candidate.aliases]),
      );
      if (!supported.has(command.name))
        throw new Error(`当前 Claude Code 未声明支持 ${command.name}。`);
    }
    const content = input.blocks.map((block) => {
      if (block.type === 'text') return { text: block.text, type: 'text' };
      if (!block.attachment.path) throw new Error('图片附件尚未由主进程安全解析。');
      const bytes = readFileSync(block.attachment.path);
      if (bytes.length !== block.attachment.size) throw new Error('附件在发送前发生变化。');
      return {
        source: {
          data: bytes.toString('base64'),
          media_type: block.attachment.mediaType,
          type: 'base64',
        },
        type: 'image',
      };
    });
    session.allowQuestionInteraction = explicitlyRequestsQuestionInteraction(input);
    session.queue.push({
      message: { content, role: 'user' },
      parent_tool_use_id: null,
      type: 'user',
      uuid: input.clientSubmissionId,
    });
    // A newly accepted foreground turn owns the next assistant stream. Clear only that lane: a
    // background tool can still be publishing its own parent-scoped assistant frames.
    session.assistantStreams.delete('foreground');
    // The streaming Agent SDK does not guarantee that it will echo the submitted user frame back
    // before assistant output starts. Publish the accepted input from our owned payload so the
    // renderer never clears the composer into an apparently empty conversation. Reusing the client
    // submission UUID also makes a future SDK echo an idempotent upsert rather than a duplicate.
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
                source: block.attachment.id,
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
    this.emit(session, { phase: 'running', type: 'conversation.phase' });
  }

  public async updateControls(
    conversationId: string,
    update: ConversationControlUpdate,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    if (update.expectedCapabilityRevision !== session.capabilityRevision) {
      throw new Error('模型能力已经变化，请按最新选项重试。');
    }
    const selectedModel = update.model ?? session.model;
    const model = session.models.find(
      (candidate) =>
        stringValue(candidate.value) === selectedModel ||
        stringValue(candidate.resolvedModel) === selectedModel,
    );
    if (!model) throw new Error('当前 Claude Code 没有声明这个模型。');
    const levels = arrayValue(model.supportedEffortLevels).filter(
      (level): level is string => typeof level === 'string',
    );
    const effort = update.effort ?? session.effort;
    if (effort && effort !== 'auto' && effort !== 'ultracode' && !levels.includes(effort)) {
      throw new Error('当前模型不支持这个思考档位。');
    }
    if (effort === 'ultracode' && !levels.includes('xhigh')) {
      throw new Error('当前模型不支持 Ultra Code 所需的 X-High。');
    }
    if (update.fast === true && model.supportsFastMode !== true) {
      throw new Error('当前模型没有声明支持 Fast。');
    }
    if (
      update.permissionMode &&
      !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(
        update.permissionMode,
      )
    ) {
      throw new Error('当前原生适配器不支持这个权限模式。');
    }
    if (
      update.permissionMode === 'bypassPermissions' &&
      session.input.allowBypassPermissions !== true
    ) {
      throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
    }

    if (update.model && update.model !== session.model) await session.query.setModel(update.model);
    const flagSettings: Record<string, unknown> = {};
    if (update.effort !== undefined) {
      flagSettings.effortLevel =
        update.effort === 'auto' ? null : update.effort === 'ultracode' ? 'xhigh' : update.effort;
      flagSettings.ultracode = update.effort === 'ultracode';
    }
    if (update.fast !== undefined) {
      flagSettings.fastMode = update.fast;
      flagSettings.fastModePerSessionOptIn = true;
    }
    if (Object.keys(flagSettings).length > 0) await session.query.applyFlagSettings(flagSettings);
    if (update.permissionMode && update.permissionMode !== session.permissionMode) {
      await session.query.setPermissionMode(sdkPermissionMode(update.permissionMode));
    }

    session.model = selectedModel;
    session.effort = effort;
    session.fast = update.fast ?? session.fast;
    session.permissionMode = update.permissionMode ?? session.permissionMode;
    session.capabilityRevision += 1;
    this.publishCapabilities(session, model, session.initialization);
  }

  public async interrupt(conversationId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    await session.query.interrupt();
  }

  public async stopTask(conversationId: string, taskId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    const task = session.tasks.get(taskId);
    if (!task?.cancellable) throw new Error('这个后台任务没有提供可取消命令。');
    await session.query.stopTask(taskId);
  }

  public async respond(
    conversationId: string,
    interactionId: string,
    response: ConversationInteractionResponse,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    const pending = session.interactions.get(interactionId);
    if (!pending) throw new Error('交互请求已结束或属于旧会话 generation。');
    session.interactions.delete(interactionId);
    pending.complete(response);
    this.emit(session, { interactionId, type: 'interaction.resolved' });
  }

  public async listCommands(conversationId: string): Promise<ConversationCommandView[]> {
    const session = this.requireSession(conversationId);
    return session.commands.map((command) => ({ ...command, aliases: [...command.aliases] }));
  }

  public async close(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    this.disposeSession(session);
    this.emit(session, { phase: 'stopped', type: 'conversation.phase' });
  }

  private async consume(session: AgentSession): Promise<void> {
    try {
      for await (const message of session.query) this.consumeMessage(session, message);
      if (this.sessions.get(session.input.conversationId) === session) {
        this.failSession(session, new Error('Claude 原生会话输入流意外结束。'));
      }
    } catch (error) {
      this.failSession(session, error);
    }
  }

  private disposeSession(session: AgentSession): boolean {
    if (this.sessions.get(session.input.conversationId) !== session) return false;
    this.sessions.delete(session.input.conversationId);
    for (const interaction of session.interactions.values()) interaction.abort();
    session.interactions.clear();
    session.queue.close();
    session.query.close();
    return true;
  }

  private failSession(session: AgentSession, error: unknown): void {
    if (!this.disposeSession(session)) return;
    this.emit(session, {
      message: error instanceof Error ? error.message : 'Claude 原生会话异常退出。',
      type: 'conversation.error',
    });
  }

  private async publishInitialization(session: AgentSession, value: unknown): Promise<void> {
    const initialization = isRecord(value) ? value : {};
    session.initialization = initialization;
    const runtimeCommands = commandRecords(initialization.commands);
    session.commands = mergeRuntimeClaudeCommands(runtimeCommands);
    this.emit(session, { commands: session.commands, type: 'commands.updated' });
    const models = arrayValue(initialization.models).filter(isRecord);
    session.models = models;
    const selected = models.find(
      (model) => model.value === session.model || model.resolvedModel === session.model,
    );
    if (selected) {
      session.capabilityRevision += 1;
      session.fast = stringValue(initialization.fast_mode_state) === 'on';
      this.publishCapabilities(session, selected, initialization);
    }
  }

  private publishCapabilities(
    session: AgentSession,
    model: Record<string, unknown>,
    initialization: Record<string, unknown>,
  ): void {
    const levels = arrayValue(model.supportedEffortLevels).filter(
      (level): level is string => typeof level === 'string',
    );
    const fastState = stringValue(initialization.fast_mode_state);
    const modelOptions = session.models.map((candidate) => {
      const candidateLevels = arrayValue(candidate.supportedEffortLevels).filter(
        (level): level is string => typeof level === 'string',
      );
      const id = stringValue(candidate.resolvedModel) ?? stringValue(candidate.value) ?? 'unknown';
      return {
        attachments: { image: true },
        effortOptions: [
          'auto',
          ...candidateLevels,
          ...(candidateLevels.includes('xhigh') ? ['ultracode'] : []),
        ],
        id,
        label: stringValue(candidate.displayName) ?? stringValue(candidate.name) ?? id,
        supportsFast: candidate.supportsFastMode === true,
        supportsUltraWorkflow: candidateLevels.includes('xhigh'),
      };
    });
    const capabilities: ModelCapabilityProfile = {
      attachments: { image: true },
      effort: {
        applied: session.effort === 'ultracode' ? 'xhigh' : session.effort,
        options: ['auto', ...levels, ...(levels.includes('xhigh') ? ['ultracode'] : [])],
        requested: session.effort,
        supportsUltraWorkflow: levels.includes('xhigh'),
      },
      evidence: 'runtime',
      fast: {
        mechanism: model.supportsFastMode === true ? 'claude-native-fast' : undefined,
        state: session.fast
          ? fastState === 'on'
            ? 'confirmed'
            : 'requested'
          : fastState === 'on'
            ? 'confirmed'
            : fastState === 'cooldown'
              ? 'fallback'
              : model.supportsFastMode === true
                ? 'off'
                : 'unavailable',
      },
      model: stringValue(model.resolvedModel) ?? stringValue(model.value) ?? 'unknown',
      models: modelOptions,
      permissionModes: [
        'default',
        'acceptEdits',
        'plan',
        ...(session.input.allowBypassPermissions ? ['bypassPermissions'] : []),
        'auto',
        'dontAsk',
      ],
      profileKey: [
        'claude',
        session.input.endpointIdentity ?? 'unknown-endpoint',
        stringValue(model.resolvedModel) ?? stringValue(model.value) ?? 'unknown-model',
        session.input.cliVersion ??
          stringValue(initialization.claude_code_version) ??
          'unknown-cli',
      ].join('|'),
      revision: session.capabilityRevision,
      runtime: 'claude',
      verifiedAt: Date.now(),
    };
    session.model = capabilities.model;
    this.emit(session, { capabilities, type: 'capabilities.updated' });
  }

  private consumeMessage(session: AgentSession, value: unknown): void {
    if (!isRecord(value)) return;
    const type = stringValue(value.type);
    if (type === 'assistant') this.consumeAssistant(session, value);
    else if (type === 'user') this.consumeToolResults(session, value);
    else if (type === 'stream_event') this.consumeStreamEvent(session, value);
    else if (type === 'tool_progress') this.consumeToolProgress(session, value);
    else if (type === 'result') this.consumeResult(session, value);
    else if (type === 'system') this.consumeSystem(session, value);
    else if (type === 'tool_use_summary') this.consumeToolSummary(session, value);
  }

  private consumeAssistant(session: AgentSession, value: Record<string, unknown>): void {
    const message = isRecord(value.message) ? value.message : {};
    const streamLane = stringValue(value.parent_tool_use_id) ?? 'foreground';
    const messageId =
      session.assistantStreams.get(streamLane) ??
      stringValue(value.uuid) ??
      stringValue(message.id) ??
      `assistant-${session.revision}-${++session.assistantStreamSequence}`;
    const blocks: ConversationContentBlock[] = [];
    for (const [index, raw] of arrayValue(message.content).entries()) {
      if (!isRecord(raw)) continue;
      const type = stringValue(raw.type);
      const id = stringValue(raw.id) ?? `${messageId}:${index}`;
      if (type === 'text') {
        blocks.push({ id, text: stringValue(raw.text) ?? '', type: 'text' });
        continue;
      }
      if (type === 'thinking') {
        blocks.push({ id, text: stringValue(raw.thinking) ?? '', type: 'thinking' });
        continue;
      }
      if (type === 'tool_use' || type === 'server_tool_use') {
        const block: Extract<ConversationContentBlock, { type: 'tool' }> = {
          id,
          input: raw.input,
          name: stringValue(raw.name) ?? 'unknown-tool',
          parentToolUseId: stringValue(value.parent_tool_use_id),
          status: 'running',
          type: 'tool',
        };
        session.tools.set(id, { block, messageId });
        blocks.push(block);
      }
    }
    this.emit(session, {
      message: {
        blocks,
        createdAt: Date.parse(stringValue(value.timestamp) ?? '') || Date.now(),
        id: messageId,
        parentToolUseId: stringValue(value.parent_tool_use_id),
        role: 'assistant',
        status: value.aborted === true ? 'aborted' : value.error ? 'failed' : 'complete',
      },
      type: 'message.upsert',
    });
    session.assistantStreams.delete(streamLane);
  }

  private consumeStreamEvent(session: AgentSession, value: Record<string, unknown>): void {
    const event = isRecord(value.event) ? value.event : {};
    const streamLane = stringValue(value.parent_tool_use_id) ?? 'foreground';
    if (event.type === 'message_start') {
      const message = isRecord(event.message) ? event.message : {};
      session.assistantStreams.set(
        streamLane,
        stringValue(value.uuid) ??
          stringValue(message.id) ??
          `assistant-stream-${session.revision}-${++session.assistantStreamSequence}`,
      );
      return;
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return;
    const index = typeof event.index === 'number' ? event.index : 0;
    const deltaType = stringValue(event.delta.type);
    const text =
      deltaType === 'text_delta'
        ? stringValue(event.delta.text)
        : deltaType === 'thinking_delta'
          ? stringValue(event.delta.thinking)
          : undefined;
    if (text === undefined) return;
    let messageId = session.assistantStreams.get(streamLane);
    if (!messageId) {
      messageId =
        stringValue(value.uuid) ??
        `assistant-stream-${session.revision}-${++session.assistantStreamSequence}`;
      session.assistantStreams.set(streamLane, messageId);
    }
    this.emit(session, {
      blockId: `${messageId}:${index}`,
      blockType: deltaType === 'thinking_delta' ? 'thinking' : 'text',
      delta: text,
      messageId,
      type: 'message.delta',
    });
  }

  private consumeToolResults(session: AgentSession, value: Record<string, unknown>): void {
    const message = isRecord(value.message) ? value.message : {};
    for (const raw of arrayValue(message.content)) {
      if (!isRecord(raw) || raw.type !== 'tool_result') continue;
      const toolUseId = stringValue(raw.tool_use_id);
      const location = toolUseId ? session.tools.get(toolUseId) : undefined;
      if (!location) continue;
      const block = {
        ...location.block,
        output: value.tool_use_result ?? raw.content,
        status: raw.is_error === true ? ('failed' as const) : ('succeeded' as const),
      };
      location.block = block;
      this.emit(session, { block, messageId: location.messageId, type: 'tool.updated' });
    }
  }

  private consumeToolProgress(session: AgentSession, value: Record<string, unknown>): void {
    const toolUseId = stringValue(value.tool_use_id);
    const location = toolUseId ? session.tools.get(toolUseId) : undefined;
    if (!location) return;
    const elapsed = typeof value.elapsed_time_seconds === 'number' ? value.elapsed_time_seconds : 0;
    const block = {
      ...location.block,
      status: 'running' as const,
      summary: `已运行 ${elapsed.toFixed(1)} 秒`,
    };
    location.block = block;
    this.emit(session, { block, messageId: location.messageId, type: 'tool.updated' });
  }

  private consumeToolSummary(session: AgentSession, value: Record<string, unknown>): void {
    const summary = stringValue(value.summary);
    if (!summary) return;
    for (const id of arrayValue(value.preceding_tool_use_ids)) {
      if (typeof id !== 'string') continue;
      const location = session.tools.get(id);
      if (!location) continue;
      const block = { ...location.block, summary };
      location.block = block;
      this.emit(session, { block, messageId: location.messageId, type: 'tool.updated' });
    }
  }

  private consumeResult(session: AgentSession, value: Record<string, unknown>): void {
    session.allowQuestionInteraction = false;
    const confirmedSubmissionId = stringValue(value.user_message_uuid);
    if (confirmedSubmissionId) {
      this.emit(session, {
        clientSubmissionId: confirmedSubmissionId,
        type: 'submission.transcript-confirmed',
      });
    }
    const usage = isRecord(value.usage) ? value.usage : {};
    this.emit(session, {
      type: 'usage.updated',
      usage: {
        costUsd: typeof value.total_cost_usd === 'number' ? value.total_cost_usd : undefined,
        durationMs: typeof value.duration_ms === 'number' ? value.duration_ms : undefined,
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        timeToFirstTokenMs: typeof value.ttft_ms === 'number' ? value.ttft_ms : undefined,
      },
    });
    if (value.is_error === true) {
      const errors = arrayValue(value.errors).filter(
        (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate),
      );
      const detail = (errors[0] ?? stringValue(value.result) ?? 'Claude 未能完成本轮请求。').slice(
        0,
        4_000,
      );
      const messageId = `turn-error-${confirmedSubmissionId ?? stringValue(value.uuid) ?? session.sequence + 1}`;
      this.emit(session, {
        message: {
          blocks: [{ id: `${messageId}:0`, text: detail, type: 'text' }],
          createdAt: Date.now(),
          id: messageId,
          role: 'system',
          status: 'failed',
        },
        type: 'message.upsert',
      });
    }
    this.emit(session, {
      // An SDK result error belongs to this turn. The streaming process remains reusable, so return
      // to idle and let the user correct or retry instead of stranding a live session as failed.
      phase: 'idle',
      type: 'conversation.phase',
    });
  }

  private consumeSystem(session: AgentSession, value: Record<string, unknown>): void {
    const subtype = stringValue(value.subtype);
    if (subtype === 'session_state_changed') {
      const state = stringValue(value.state);
      this.emit(session, {
        phase:
          state === 'idle' ? 'idle' : state === 'requires_action' ? 'requires-action' : 'running',
        type: 'conversation.phase',
      });
      return;
    }
    if (subtype === 'commands_changed') {
      session.commands = mergeRuntimeClaudeCommands(commandRecords(value.commands));
      this.emit(session, { commands: session.commands, type: 'commands.updated' });
      return;
    }
    if (subtype === 'background_tasks_changed') {
      const liveIds = new Set<string>();
      for (const raw of arrayValue(value.tasks)) {
        if (!isRecord(raw) || typeof raw.task_id !== 'string') continue;
        liveIds.add(raw.task_id);
        const existing = session.tasks.get(raw.task_id);
        session.tasks.set(raw.task_id, {
          cancellable: true,
          description: stringValue(raw.description) ?? existing?.description ?? '后台任务',
          id: raw.task_id,
          kind: stringValue(raw.task_type) === 'web' ? 'web' : 'background',
          status: 'running',
          updatedAt: Date.now(),
        });
      }
      for (const [id, task] of session.tasks) {
        if (!liveIds.has(id) && ['queued', 'running', 'waiting'].includes(task.status)) {
          session.tasks.set(id, { ...task, status: 'lost', updatedAt: Date.now() });
        }
      }
      this.publishTasks(session);
      return;
    }
    if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated') {
      this.consumeTaskEdge(session, value);
      return;
    }
    if (subtype === 'task_notification') this.consumeTaskNotification(session, value);
  }

  private consumeTaskEdge(session: AgentSession, value: Record<string, unknown>): void {
    const id = stringValue(value.task_id);
    if (!id) return;
    const existing = session.tasks.get(id);
    const patch = isRecord(value.patch) ? value.patch : {};
    const rawStatus = stringValue(patch.status);
    const status: ConversationTaskView['status'] =
      rawStatus === 'pending'
        ? 'queued'
        : rawStatus === 'completed'
          ? 'completed'
          : rawStatus === 'failed'
            ? 'failed'
            : rawStatus === 'killed'
              ? 'stopped'
              : rawStatus === 'paused'
                ? 'waiting'
                : 'running';
    session.tasks.set(id, {
      cancellable: !['completed', 'failed', 'stopped'].includes(status),
      description:
        stringValue(value.description) ??
        stringValue(patch.description) ??
        existing?.description ??
        '子智能体任务',
      id,
      kind: stringValue(value.task_type) === 'local_workflow' ? 'workflow' : 'subagent',
      status,
      summary: stringValue(value.summary),
      updatedAt: Date.now(),
    });
    this.publishTasks(session);
  }

  private consumeTaskNotification(session: AgentSession, value: Record<string, unknown>): void {
    const id = stringValue(value.task_id);
    if (!id) return;
    const existing = session.tasks.get(id);
    const rawStatus = stringValue(value.status);
    session.tasks.set(id, {
      cancellable: false,
      description: existing?.description ?? '后台任务',
      id,
      kind: existing?.kind ?? 'background',
      status:
        rawStatus === 'completed' ? 'completed' : rawStatus === 'stopped' ? 'stopped' : 'failed',
      summary: stringValue(value.summary),
      updatedAt: Date.now(),
    });
    this.publishTasks(session);
  }

  private publishTasks(session: AgentSession): void {
    this.emit(session, { tasks: [...session.tasks.values()], type: 'tasks.reconciled' });
  }

  private async requestToolPermission(
    session: AgentSession,
    toolName: string,
    input: Record<string, unknown>,
    permission: Record<string, unknown>,
  ): Promise<unknown> {
    if (session.permissionMode === 'dontAsk') {
      if (toolName !== 'AskUserQuestion' || !session.allowQuestionInteraction) {
        return {
          behavior: 'deny',
          message:
            toolName === 'AskUserQuestion'
              ? '当前为「仅预批准」；只有用户在本轮明确要求选项或选择题时才显示交互卡。'
              : '当前为「仅预批准」；未被规则预先批准的工具请求已直接拒绝。',
        };
      }
      // One AskUserQuestion call can carry up to four questions. Consume the explicit exception so
      // the model cannot turn one user request into an unbounded sequence of follow-up prompts.
      session.allowQuestionInteraction = false;
    }
    const id = stringValue(permission.requestId) ?? `permission-${session.sequence + 1}`;
    const toolUseId = stringValue(permission.toolUseID) ?? id;
    let interaction: ConversationInteraction;
    if (toolName === 'AskUserQuestion') {
      interaction = {
        createdAt: Date.now(),
        id,
        kind: 'question',
        questions: arrayValue(input.questions),
        title: stringValue(permission.title) ?? 'Claude 需要你的选择',
      };
    } else if (toolName === 'ExitPlanMode') {
      interaction = {
        approvalModes: ['default', 'acceptEdits'],
        createdAt: Date.now(),
        id,
        kind: 'plan',
        markdown: stringValue(input.plan) ?? stringValue(input.content) ?? '',
        title: stringValue(permission.title) ?? '检查实施计划',
      };
    } else {
      interaction = {
        allowRemember: Array.isArray(permission.suggestions) && permission.suggestions.length > 0,
        createdAt: Date.now(),
        description: stringValue(permission.description) ?? stringValue(permission.decisionReason),
        id,
        input,
        kind: 'permission',
        title: stringValue(permission.title) ?? `Claude 请求使用 ${toolName}`,
        toolName,
        toolUseId,
      };
    }
    return this.awaitInteraction(session, interaction, (response) => {
      if (response.action === 'allow' || response.action === 'submit') {
        return {
          behavior: 'allow',
          updatedInput: response.values ? { ...input, ...response.values } : input,
          updatedPermissions:
            response.action === 'allow' && response.remember ? permission.suggestions : undefined,
        };
      }
      return {
        behavior: 'deny',
        message: response.action === 'deny' ? (response.message ?? '用户拒绝。') : '用户取消。',
      };
    });
  }

  private async requestElicitation(
    session: AgentSession,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = stringValue(request.elicitationId) ?? `mcp-${session.sequence + 1}`;
    const interaction: ConversationInteraction = {
      createdAt: Date.now(),
      description: stringValue(request.description) ?? stringValue(request.message),
      id,
      kind: 'mcp',
      mode: request.mode === 'url' ? 'url' : 'form',
      schema: isRecord(request.requestedSchema) ? request.requestedSchema : undefined,
      title: stringValue(request.title) ?? stringValue(request.displayName) ?? 'MCP 请求输入',
      url: stringValue(request.url),
    };
    return this.awaitInteraction(
      session,
      interaction,
      (response) =>
        response.action === 'submit' || response.action === 'allow'
          ? { action: 'accept', content: response.values }
          : { action: response.action === 'deny' ? 'decline' : 'cancel' },
      signal,
    );
  }

  private awaitInteraction(
    session: AgentSession,
    interaction: ConversationInteraction,
    translate: (response: ConversationInteractionResponse) => unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.emit(session, { interaction, type: 'interaction.requested' });
    return new Promise((resolve) => {
      const abort = (): void => {
        session.interactions.delete(interaction.id);
        resolve(
          interaction.kind === 'mcp'
            ? { action: 'cancel' }
            : { behavior: 'deny', message: '会话已中止。' },
        );
      };
      session.interactions.set(interaction.id, {
        abort,
        complete: (response) => resolve(translate(response)),
      });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private mappingLabel(mapping: ConversationCommandView['mapping']): string {
    return mapping === 'claudedock'
      ? '页面'
      : mapping === 'form'
        ? '原生表单'
        : mapping === 'terminal-only'
          ? '高级终端入口'
          : '兼容检测';
  }

  private requireSession(conversationId: string): AgentSession {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error('Claude 原生会话不存在。');
    return session;
  }

  private emit(session: AgentSession, event: AgentEventBody): void {
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
