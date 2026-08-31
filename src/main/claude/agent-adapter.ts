import { readFileSync } from 'node:fs';
import {
  mergeRuntimeClaudeCommands,
  resolveClaudeNativeCommand,
} from '../../shared/claude/native-commands';
import {
  claudeModelIdsMatch,
  resolveClaudeRuntimeModel,
  stripClaudeContextWindowSuffix,
} from '../../shared/claude/model-id';
import type {
  ConversationAdapter,
  ConversationControlUpdate,
  ConversationCommandView,
  ConversationEvent,
  ConversationInteraction,
  ConversationInteractionResponse,
  ConversationStartInput,
  ConversationSubmitInput,
  ModelCapabilityProfile,
} from '../../shared/conversation/native';
import {
  AsyncInputQueue,
  buildClaudeAgentProcessEnvironment,
  defaultQueryFactory,
  defaultResolveExecutable,
  type SdkQueryFactory,
} from './agent-adapter-bootstrap';
import { consumeMessage } from './agent-adapter-events';
import type { AgentEventBody, AgentEventEmit, AgentSession } from './agent-adapter-types';
import {
  arrayValue,
  canonicalModelForSession,
  commandRecords,
  explicitlyRequestsQuestionInteraction,
  isRecord,
  modelHasOneMillionContext,
  modelRecordMatches,
  normalizedPermissionMode,
  sdkPermissionMode,
  stringValue,
} from './agent-adapter-values';
export {
  buildClaudeAgentProcessEnvironment,
  claudeAgentExecutableFromCommand,
} from './agent-adapter-bootstrap';

export interface ClaudeAgentAdapterOptions {
  appVersion: string;
  environment?: (input: ConversationStartInput) => Record<string, null | string | undefined>;
  queryFactory?: () => Promise<SdkQueryFactory>;
  resolveExecutable?: (cwd: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  startTimeoutMs?: number;
}

const MAX_TRANSPORT_RECOVERY_ATTEMPTS = 2;

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
    const revision = (this.startRevisions.get(input.conversationId) ?? 0) + 1;
    this.startRevisions.set(input.conversationId, revision);
    const assertStartCurrent = (): void => {
      if (this.startRevisions.get(input.conversationId) !== revision) {
        throw new Error('Claude 原生会话启动已取消。');
      }
    };
    const permissionMode = normalizedPermissionMode(input.permissionMode);
    if (permissionMode === 'bypassPermissions' && input.allowBypassPermissions !== true) {
      throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
    }
    const environment = buildClaudeAgentProcessEnvironment(process.env, {
      ...this.options.environment?.(input),
      CLAUDE_AGENT_SDK_CLIENT_APP: `ClaudeDock/${this.options.appVersion}`,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      ELECTRON_RUN_AS_NODE: null,
    });
    const [factory, executable] = await Promise.all([
      (this.options.queryFactory ?? defaultQueryFactory)(),
      (this.options.resolveExecutable ?? defaultResolveExecutable)(input.projectPath, environment),
    ]);
    assertStartCurrent();
    const queue = new AsyncInputQueue();
    const sessionReference: { current?: AgentSession } = {};
    const requireSession = (): AgentSession => {
      if (!sessionReference.current) throw new Error('Claude 原生会话尚未完成初始化。');
      return sessionReference.current;
    };
    const runtimeModel = input.runtimeModel ?? input.model;
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
      model: runtimeModel,
      onElicitation: async (request: Record<string, unknown>, context: { signal: AbortSignal }) =>
        this.requestElicitation(requireSession(), request, context.signal),
      pathToClaudeCodeExecutable: executable,
      permissionMode: sdkPermissionMode(permissionMode),
      persistSession: true,
      settingSources: ['user', 'project', 'local'],
      // Opting into the tools preset is not enough: the SDK treats an omitted `systemPrompt` as a
      // custom EMPTY prompt (`if (s === void 0) d = ""`), not as "use Claude Code's". Leaving it out
      // therefore strips every behavioural instruction the CLI ships with — tool-use discipline,
      // search-before-edit habits, output conventions — while still exposing the same tools. The
      // model looks measurably worse here than in the terminal for no reason other than this line.
      systemPrompt: { preset: 'claude_code', type: 'preset' },
      tools: { preset: 'claude_code', type: 'preset' },
    };
    // The terminal lane writes `skipWebFetchPreflight: true` into its --settings file
    // (`claude-runtime.ts`), so WebFetch there never stalls on the blocklist preflight. Native has to
    // say the same thing through the inline settings layer or the identical request behaves worse in
    // one lane than the other for no reason the user chose.
    adapterOptions.settings = {
      skipWebFetchPreflight: true,
      ...(input.settingsEnvironment ? { env: { ...input.settingsEnvironment } } : {}),
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
      runtimeModel,
      sequence: 0,
      tasks: new Map(),
      tools: new Map(),
    };
    const assertSessionCurrent = (): void => {
      assertStartCurrent();
      if (this.sessions.get(input.conversationId) !== session) {
        throw new Error('Claude 原生会话启动已取消。');
      }
    };
    sessionReference.current = session;
    this.sessions.set(input.conversationId, session);
    this.emit(session, { ownerKind: input.ownerKind, type: 'conversation.started' });
    const consume = this.consume(session);
    const timeoutMs = this.options.startTimeoutMs ?? 30_000;
    let initializationTimer: NodeJS.Timeout | undefined;
    try {
      const initialization = await Promise.race([
        query.initializationResult(),
        new Promise<never>((_resolve, reject) => {
          initializationTimer = setTimeout(
            () => reject(new Error(`Claude 原生会话在 ${timeoutMs} 毫秒内没有完成初始化。`)),
            timeoutMs,
          );
          initializationTimer.unref();
        }),
      ]);
      assertSessionCurrent();
      await this.publishInitialization(session, initialization);
      assertSessionCurrent();
      this.emit(session, { phase: 'idle', type: 'conversation.phase' });
      void consume;
    } catch (error) {
      if (this.disposeSession(session)) {
        this.emit(session, { phase: 'stopped', type: 'conversation.phase' });
      }
      throw error;
    } finally {
      if (initializationTimer) clearTimeout(initializationTimer);
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
    const model = session.models.find((candidate) => modelRecordMatches(candidate, selectedModel));
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

    if (
      update.model &&
      (session.model === undefined || !claudeModelIdsMatch(update.model, session.model))
    ) {
      const runtimeModel = modelHasOneMillionContext(session.runtimeModel)
        ? resolveClaudeRuntimeModel(update.model, 'extended')
        : stripClaudeContextWindowSuffix(update.model);
      await session.query.setModel(runtimeModel);
      session.runtimeModel = runtimeModel;
    }
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
    this.startRevisions.set(conversationId, (this.startRevisions.get(conversationId) ?? 0) + 1);
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (this.disposeSession(session)) {
      this.emit(session, { phase: 'stopped', type: 'conversation.phase' });
    }
  }

  private async consume(session: AgentSession): Promise<void> {
    const emit: AgentEventEmit = (target, event) => {
      if (this.sessions.get(target.input.conversationId) === target) this.emit(target, event);
    };
    let transportRecoveryAttempts = 0;
    while (this.sessions.get(session.input.conversationId) === session) {
      try {
        for await (const message of session.query) {
          // A successfully received frame proves that the stream recovered; a later, unrelated
          // transport gap gets its own bounded retry budget instead of inheriting an old failure.
          transportRecoveryAttempts = 0;
          consumeMessage(session, message, emit);
        }
        if (this.sessions.get(session.input.conversationId) === session) {
          this.failSession(session, new Error('Claude 原生会话输入流意外结束。'));
        }
        return;
      } catch (error) {
        if (
          this.sessions.get(session.input.conversationId) !== session ||
          transportRecoveryAttempts >= MAX_TRANSPORT_RECOVERY_ATTEMPTS ||
          !(await this.reinitializeAfterTransportGap(session))
        ) {
          this.failSession(session, error);
          return;
        }
        transportRecoveryAttempts += 1;
      }
    }
  }

  private async reinitializeAfterTransportGap(session: AgentSession): Promise<boolean> {
    const reinitialize = session.query.reinitialize;
    if (!reinitialize || this.sessions.get(session.input.conversationId) !== session) return false;
    try {
      const initialization = await reinitialize.call(session.query);
      if (this.sessions.get(session.input.conversationId) !== session) return false;
      await this.publishInitialization(session, initialization);
      return this.sessions.get(session.input.conversationId) === session;
    } catch {
      return false;
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
    const selected = models.find((model) => modelRecordMatches(model, session.model));
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
      const runtimeId =
        stringValue(candidate.resolvedModel) ?? stringValue(candidate.value) ?? 'unknown';
      const id = modelRecordMatches(candidate, session.model)
        ? (session.model ?? canonicalModelForSession(session, runtimeId))
        : canonicalModelForSession(session, runtimeId);
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
    const runtimeModelId =
      stringValue(model.resolvedModel) ?? stringValue(model.value) ?? 'unknown';
    const canonicalModel = modelRecordMatches(model, session.model)
      ? (session.model ?? canonicalModelForSession(session, runtimeModelId))
      : canonicalModelForSession(session, runtimeModelId);
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
      model: canonicalModel,
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
        canonicalModel,
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
