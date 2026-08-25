import { z } from 'zod';
import type {
  ClaudeEffortRequest,
  ClaudeLaunchMode,
  ClaudeLaunchPreflightDecisionInput,
  ClaudePermissionDecision,
  ClaudePermissionMode,
  ClaudeProviderModelDiscoveryInput,
  ClaudeRelaunchInput,
  CodexInstallOperation,
  CodexLaunchMode,
  CodexLoginMethod,
  ControlPanelApi,
  DevelopmentRuntime,
  McpInstallInput,
  McpRemoveInput,
  McpScope,
  ModelSpeedMode,
  NetworkPreflightAction,
  NetworkPreflightRunInput,
  NetworkProviderId,
  PtyGeneration,
  SaveClaudeConfigInput,
  SaveClaudeRouterProviderInput,
} from '../contracts';
import type {
  ConversationControlUpdate,
  ConversationInteractionResponse,
  ConversationSubmitInput,
} from '../conversation/native';
import { CLAUDE_EFFORT_REQUESTS } from '../claude/effort';
import { claudeProviderIdSet } from '../claude/providers';
import { CHANNELS, type EventChannel, type RequestChannel, type SendChannel } from './channels';
import { claudeExecutionSettingsRequestSchema } from './claude-execution-settings-schema';

export * from './claude-execution-settings-schema';

const SESSION_ID_PATTERN = /^session-\d{1,10}$/u;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DOWNLOAD_TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HISTORY_ENTRY_ID_PATTERN = /^history-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/u;
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MODEL_OPTION_ID_PATTERN = /^(?:current|history-[a-z0-9]{1,16}-[a-z0-9]{1,16})$/u;
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$/u;
const NATIVE_SUBMIT_AUTHORITY_FIELDS = new Set([
  'action',
  'cwd',
  'networkScope',
  'officialNetworkProvider',
  'officialNetworkTarget',
  'projectPath',
  'provider',
  'target',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const guarded = <T>(predicate: (value: unknown) => value is T, message: string): z.ZodType<T> =>
  z.custom<T>(predicate, { error: message });

const addIssue = (context: z.RefinementCtx, message: string): void => {
  context.addIssue({ code: 'custom', message });
};

export const sessionIdSchema = guarded<string>(
  (value): value is string => typeof value === 'string' && SESSION_ID_PATTERN.test(value),
  '项目会话标识无效。',
);

export const ptyGenerationSchema = guarded<PtyGeneration>(
  (value): value is PtyGeneration =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  '终端代次无效。',
);

export const conversationIdSchema = guarded<string>(
  (value): value is string => typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value),
  '原生对话 UUID 无效。',
).transform((value) => value.toLowerCase());

export const nativeSubmitInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, '原生对话输入格式无效。');
      return;
    }
    if (Object.keys(value).some((key) => NATIVE_SUBMIT_AUTHORITY_FIELDS.has(key))) {
      addIssue(context, '原生对话输入包含未授权字段。');
      return;
    }
    if (
      typeof value.clientSubmissionId !== 'string' ||
      !value.clientSubmissionId ||
      value.clientSubmissionId.length > 200 ||
      !Array.isArray(value.blocks) ||
      value.blocks.length === 0 ||
      value.blocks.length > 20
    ) {
      addIssue(context, '原生对话输入格式无效。');
      return;
    }
    for (const block of value.blocks) {
      if (!isRecord(block)) {
        addIssue(context, '原生对话内容块无效。');
        return;
      }
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || !block.text || block.text.length > 2_000_000) {
          addIssue(context, '原生对话文本为空或过长。');
          return;
        }
        continue;
      }
      if (
        block.type !== 'image' ||
        !isRecord(block.attachment) ||
        typeof block.attachment.id !== 'string' ||
        !CONVERSATION_ID_PATTERN.test(block.attachment.id) ||
        typeof block.attachment.mediaType !== 'string' ||
        typeof block.attachment.name !== 'string' ||
        typeof block.attachment.size !== 'number'
      ) {
        addIssue(context, '原生对话附件格式无效。');
        return;
      }
    }
  })
  .transform((value) => value as ConversationSubmitInput);

export const nativeInteractionResponseObjectSchema = guarded<Record<string, unknown>>(
  isRecord,
  '原生交互响应无效。',
);

export const nativeInteractionResponseSchema = nativeInteractionResponseObjectSchema
  .superRefine((value, context) => {
    if (!['allow', 'deny', 'cancel', 'submit'].includes(String(value.action ?? ''))) {
      addIssue(context, '原生交互响应动作无效。');
    }
  })
  .transform((value) => value as ConversationInteractionResponse);

export const nativeControlUpdateSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, '模型控制参数无效。');
      return;
    }
    if (
      !Number.isSafeInteger(value.expectedCapabilityRevision) ||
      Number(value.expectedCapabilityRevision) < 0 ||
      (value.model !== undefined &&
        (typeof value.model !== 'string' || value.model.length > 200)) ||
      (value.effort !== undefined &&
        !['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(
          String(value.effort),
        )) ||
      (value.fast !== undefined && typeof value.fast !== 'boolean') ||
      (value.permissionMode !== undefined &&
        !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(
          String(value.permissionMode),
        ))
    ) {
      addIssue(context, '模型控制参数无效。');
    }
  })
  .transform((value) => value as ConversationControlUpdate);

export const downloadTaskIdSchema = guarded<string>(
  (value): value is string => typeof value === 'string' && DOWNLOAD_TASK_ID_PATTERN.test(value),
  '下载任务标识无效。',
);

export const developmentRuntimeSchema = guarded<DevelopmentRuntime>(
  (value): value is DevelopmentRuntime => value === 'claude' || value === 'codex',
  '开发引擎标识无效。',
);

export const networkProviderSchema = guarded<NetworkProviderId>(
  (value): value is NetworkProviderId =>
    value === 'ai-services' ||
    value === 'anthropic-claude' ||
    value === 'openai-api' ||
    value === 'openai-codex' ||
    value === 'xai-grok',
  '网络预检服务商标识无效。',
);

export const networkPreflightActionSchema = guarded<NetworkPreflightAction>(
  (value): value is NetworkPreflightAction =>
    value === 'background' ||
    value === 'cli-launch' ||
    value === 'cloud-task' ||
    value === 'first-request' ||
    value === 'login' ||
    value === 'provider-switch',
  '网络预检动作标识无效。',
);

export const claudeLaunchModeSchema = guarded<ClaudeLaunchMode>(
  (value): value is ClaudeLaunchMode =>
    value === 'new' || value === 'continue' || value === 'resume',
  'Claude 会话启动方式无效。',
);

export const claudeLaunchPreflightDecisionInputSchema = z
  .object({
    choice: z.enum(['cancel', 'recheck', 'bypass']),
    decisionId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u, 'Claude 启动决策标识无效。'),
  })
  .strict() satisfies z.ZodType<ClaudeLaunchPreflightDecisionInput>;

export const codexLaunchModeSchema = claudeLaunchModeSchema.transform(
  (value) => value as CodexLaunchMode,
);

export const codexLoginMethodSchema = guarded<CodexLoginMethod>(
  (value): value is CodexLoginMethod => value === 'browser' || value === 'device-code',
  'Codex 登录方式无效。',
);

export const codexInstallOperationSchema = guarded<CodexInstallOperation>(
  (value): value is CodexInstallOperation => value === 'install' || value === 'update',
  'Codex 安装操作无效。',
);

export const claudePermissionModeSchema = guarded<ClaudePermissionMode>(
  (value): value is ClaudePermissionMode =>
    value === 'acceptEdits' ||
    value === 'auto' ||
    value === 'bypassPermissions' ||
    value === 'default' ||
    value === 'dontAsk' ||
    value === 'plan',
  '权限模式标识无效。',
);

export const claudeEffortRequestSchema = guarded<ClaudeEffortRequest>(
  (value): value is ClaudeEffortRequest =>
    typeof value === 'string' && CLAUDE_EFFORT_REQUESTS.has(value as ClaudeEffortRequest),
  '思考程度标识无效。',
);

export const modelSpeedModeSchema = guarded<ModelSpeedMode>(
  (value): value is ModelSpeedMode => value === 'fast' || value === 'standard',
  '模型服务速度标识无效。',
);

export const modelOptionIdSchema = guarded<string>(
  (value): value is string =>
    typeof value === 'string' && MODEL_OPTION_ID_PATTERN.test(value.replace(/^history:/u, '')),
  '模型选项标识无效。',
);

export const historyEntryIdSchema = guarded<string>(
  (value): value is string => typeof value === 'string' && HISTORY_ENTRY_ID_PATTERN.test(value),
  '接入记录标识无效。',
);

export const claudeRelaunchInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value) || typeof value.compactFirst !== 'boolean') {
      addIssue(context, '会话重启参数无效。');
      return;
    }
    if (value.entryId !== undefined) {
      const result = historyEntryIdSchema.safeParse(value.entryId);
      if (!result.success)
        addIssue(context, result.error.issues[0]?.message ?? '接入记录标识无效。');
    }
    if (value.permissionMode !== undefined) {
      const result = claudePermissionModeSchema.safeParse(value.permissionMode);
      if (!result.success)
        addIssue(context, result.error.issues[0]?.message ?? '权限模式标识无效。');
    }
  })
  .transform((value) => {
    const input = value as Record<string, unknown>;
    return {
      compactFirst: input.compactFirst as boolean,
      entryId: input.entryId as string | undefined,
      permissionMode: input.permissionMode as ClaudePermissionMode | undefined,
    } satisfies ClaudeRelaunchInput;
  });

export const claudeConfigInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, 'Claude 接入配置格式无效。');
      return;
    }
    if (
      (value.provider !== 'anthropic' && value.provider !== 'gateway') ||
      typeof value.preset !== 'string' ||
      !claudeProviderIdSet.has(value.preset) ||
      (value.authMode !== 'apiKey' &&
        value.authMode !== 'authToken' &&
        value.authMode !== 'existing' &&
        value.authMode !== 'none') ||
      (value.credentialAction !== 'clear' &&
        value.credentialAction !== 'keep' &&
        value.credentialAction !== 'replace') ||
      (value.apiKeyHelperPolicy !== undefined &&
        value.apiKeyHelperPolicy !== 'inherit' &&
        value.apiKeyHelperPolicy !== 'prefer-claudedock') ||
      typeof value.baseUrl !== 'string' ||
      typeof value.model !== 'string' ||
      (value.modelFast !== undefined && typeof value.modelFast !== 'string') ||
      (value.credential !== undefined && typeof value.credential !== 'string') ||
      (value.protocol !== undefined &&
        value.protocol !== 'anthropic' &&
        value.protocol !== 'openai') ||
      (value.routerProviderId !== undefined && typeof value.routerProviderId !== 'string')
    ) {
      addIssue(context, 'Claude 接入配置包含无效字段。');
    }
  })
  .transform((value) => {
    const input = value as Record<string, unknown>;
    return {
      apiKeyHelperPolicy: input.apiKeyHelperPolicy as SaveClaudeConfigInput['apiKeyHelperPolicy'],
      authMode: input.authMode as SaveClaudeConfigInput['authMode'],
      baseUrl: input.baseUrl as string,
      credential: input.credential as string | undefined,
      credentialAction: input.credentialAction as SaveClaudeConfigInput['credentialAction'],
      model: input.model as string,
      modelFast: input.modelFast as string | undefined,
      preset: input.preset as SaveClaudeConfigInput['preset'],
      protocol: input.protocol as SaveClaudeConfigInput['protocol'],
      provider: input.provider as SaveClaudeConfigInput['provider'],
      routerProviderId: input.routerProviderId as string | undefined,
    } satisfies SaveClaudeConfigInput;
  });

export const claudeRouterProviderInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, '路由器服务提供方配置格式无效。');
      return;
    }
    if (
      (value.id !== undefined && typeof value.id !== 'string') ||
      typeof value.name !== 'string' ||
      typeof value.baseUrl !== 'string' ||
      !Array.isArray(value.models) ||
      !value.models.every((model) => typeof model === 'string') ||
      (value.protocol !== 'anthropic_messages' &&
        value.protocol !== 'openai_chat_completions' &&
        value.protocol !== 'openai_responses') ||
      (value.credentialAction !== 'clear' &&
        value.credentialAction !== 'keep' &&
        value.credentialAction !== 'replace') ||
      (value.apiKey !== undefined && typeof value.apiKey !== 'string') ||
      typeof value.makePreferred !== 'boolean' ||
      typeof value.useForCurrentProject !== 'boolean'
    ) {
      addIssue(context, '路由器服务提供方配置包含无效字段。');
    }
  })
  .transform((value) => {
    const input = value as Record<string, unknown>;
    return {
      apiKey: input.apiKey as string | undefined,
      baseUrl: input.baseUrl as string,
      credentialAction: input.credentialAction as SaveClaudeRouterProviderInput['credentialAction'],
      id: input.id as string | undefined,
      makePreferred: input.makePreferred as boolean,
      models: input.models as string[],
      name: input.name as string,
      protocol: input.protocol as SaveClaudeRouterProviderInput['protocol'],
      useForCurrentProject: input.useForCurrentProject as boolean,
    } satisfies SaveClaudeRouterProviderInput;
  });

export const externalUrlInputSchema = guarded<string>(
  (value): value is string => typeof value === 'string' && value.length <= 2048,
  '外部链接格式无效。',
);

export const markdownExternalUrlInputSchema = guarded<string>(
  (value): value is string =>
    typeof value === 'string' && value.length <= 4096 && !/[\r\n]/u.test(value),
  '对话链接格式无效。',
);

export const pluginIdSchema = guarded<string>(
  (value): value is string => typeof value === 'string' && PLUGIN_ID_PATTERN.test(value),
  '插件标识无效。',
);

export const mcpScopeSchema = guarded<McpScope>(
  (value): value is McpScope => value === 'local' || value === 'project' || value === 'user',
  'MCP 作用域无效。',
);

export const projectPathInputSchema = guarded<string>(
  (value): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 4096,
  '项目路径格式无效。',
);

export const networkPreflightRunInputSchema = z
  .object({
    action: networkPreflightActionSchema,
    cwd: projectPathInputSchema.optional(),
    force: z.boolean().optional(),
    networkScope: z.enum(['application', 'conversation']).optional(),
    provider: networkProviderSchema,
  })
  .strict()
  .transform(
    (value) =>
      ({
        action: value.action,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        ...(value.force === undefined ? {} : { force: value.force }),
        ...(value.networkScope === undefined ? {} : { networkScope: value.networkScope }),
        provider: value.provider,
      }) satisfies NetworkPreflightRunInput,
  );

export const mcpInstallInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, 'MCP 安装参数无效。');
      return;
    }
    if (Object.keys(value).some((key) => !['catalogId', 'cwd', 'scope'].includes(key))) {
      addIssue(context, 'MCP 安装参数包含未授权字段。');
      return;
    }
    if (typeof value.catalogId !== 'string' || value.catalogId.length > 240) {
      addIssue(context, 'MCP 目录条目标识无效。');
      return;
    }
    const cwd = projectPathInputSchema.safeParse(value.cwd);
    if (!cwd.success) {
      addIssue(context, cwd.error.issues[0]?.message ?? '项目路径格式无效。');
      return;
    }
    const scope = mcpScopeSchema.safeParse(value.scope);
    if (!scope.success) addIssue(context, scope.error.issues[0]?.message ?? 'MCP 作用域无效。');
  })
  .transform((value) => {
    const input = value as Record<string, unknown>;
    return {
      catalogId: input.catalogId as string,
      cwd: input.cwd as string,
      scope: input.scope as McpScope,
    } satisfies McpInstallInput;
  });

export const mcpRemoveInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, 'MCP 卸载参数无效。');
      return;
    }
    if (typeof value.name !== 'string' || !MCP_NAME_PATTERN.test(value.name)) {
      addIssue(context, 'MCP 名称无效。');
      return;
    }
    const cwd = projectPathInputSchema.safeParse(value.cwd);
    if (!cwd.success) {
      addIssue(context, cwd.error.issues[0]?.message ?? '项目路径格式无效。');
      return;
    }
    const scope = mcpScopeSchema.safeParse(value.scope);
    if (!scope.success) addIssue(context, scope.error.issues[0]?.message ?? 'MCP 作用域无效。');
  })
  .transform((value) => {
    const input = value as Record<string, unknown>;
    return {
      cwd: input.cwd as string,
      name: input.name as string,
      scope: input.scope as McpScope,
    } satisfies McpRemoveInput;
  });

export const providerModelDiscoveryInputSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, '模型发现参数无效。');
      return;
    }
    if (
      Object.keys(value).some((key) => key !== 'baseUrl' && key !== 'credential') ||
      typeof value.baseUrl !== 'string' ||
      value.baseUrl.length > 2048 ||
      (value.credential !== undefined &&
        (typeof value.credential !== 'string' || value.credential.length > 20_000))
    ) {
      addIssue(context, '模型发现参数包含无效字段。');
    }
  })
  .transform((value) => {
    const input = value as Record<string, unknown>;
    return {
      baseUrl: input.baseUrl as string,
      credential: input.credential as string | undefined,
    } satisfies ClaudeProviderModelDiscoveryInput;
  });

export const claudePermissionDecisionSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      addIssue(context, '权限确认结果无效。');
      return;
    }
    if (value.behavior === 'fallback') return;
    if (value.behavior === 'allow') {
      if (
        value.suggestionId !== undefined &&
        (typeof value.suggestionId !== 'string' || value.suggestionId.length > 200)
      ) {
        addIssue(context, '权限范围无效。');
      }
      return;
    }
    if (value.behavior === 'deny') {
      if (value.message !== undefined && typeof value.message !== 'string') {
        addIssue(context, '拒绝原因无效。');
      }
      return;
    }
    addIssue(context, '权限确认结果无效。');
  })
  .transform((value): ClaudePermissionDecision => {
    const decision = value as Record<string, unknown>;
    if (decision.behavior === 'fallback') return { behavior: 'fallback' };
    if (decision.behavior === 'allow') {
      return {
        behavior: 'allow',
        ...(decision.suggestionId ? { suggestionId: decision.suggestionId as string } : {}),
      };
    }
    return {
      behavior: 'deny',
      ...(decision.message ? { message: String(decision.message).slice(0, 300) } : {}),
    };
  });

type AsyncControlPanelMethod = {
  [Method in keyof ControlPanelApi]: ControlPanelApi[Method] extends (
    ...args: never[]
  ) => Promise<unknown>
    ? Method
    : never;
}[keyof ControlPanelApi];

type RequestMethod = Extract<AsyncControlPanelMethod, string>;
type RequestArguments<Method extends RequestMethod> = Parameters<ControlPanelApi[Method]>;

type IpcRequestDefinition<Method extends RequestMethod> = {
  readonly args: z.ZodType<RequestArguments<Method>>;
  readonly method: Method;
};

const request = <Method extends RequestMethod>(
  method: Method,
  fields: readonly z.ZodType[],
): IpcRequestDefinition<Method> => {
  const args = fields.length === 0 ? z.tuple([]) : z.tuple(fields as [z.ZodType, ...z.ZodType[]]);
  return {
    args: args as unknown as z.ZodType<RequestArguments<Method>>,
    method,
  };
};

export const IPC_REQUESTS = {
  [CHANNELS.APP_CLIPBOARD_READ]: request('readClipboardText', []),
  [CHANNELS.APP_CLIPBOARD_WRITE]: request('writeClipboardText', [z.string()]),
  [CHANNELS.APP_GET_SETTINGS]: request('getAppSettings', []),
  [CHANNELS.APP_GET_DIAGNOSTICS]: request('getDiagnostics', [z.unknown().optional()]),
  [CHANNELS.APP_OPEN_EXTERNAL]: request('openExternal', [externalUrlInputSchema]),
  [CHANNELS.APP_SET_ADVANCED_SETTINGS]: request('setAdvancedSettings', [z.unknown()]),
  [CHANNELS.APP_SET_CLAUDE_CONTEXT_WINDOW_MODE]: request('setClaudeContextWindowMode', [
    z.unknown(),
    z.number().optional(),
  ]),
  [CHANNELS.APP_SET_CLOSE_BEHAVIOR]: request('setCloseBehavior', [z.unknown()]),
  [CHANNELS.APP_SET_FOOTER_RESOURCE_PREFERENCE]: request('setFooterResourcePreference', [
    z.unknown(),
  ]),
  [CHANNELS.APP_SET_LAUNCH_AT_LOGIN]: request('setLaunchAtLogin', [z.boolean()]),
  [CHANNELS.APP_SET_MANAGED_CHATGPT_CONTEXT_WINDOW_MODE]: request(
    'setManagedChatGptContextWindowMode',
    [z.unknown()],
  ),
  [CHANNELS.ONBOARDING_COMPLETE]: request('completeOnboarding', []),
  [CHANNELS.ONBOARDING_GET]: request('getOnboardingState', []),
  [CHANNELS.ONBOARDING_RESET]: request('resetOnboarding', []),
  [CHANNELS.ONBOARDING_SKIP]: request('skipOnboarding', []),
  [CHANNELS.ONBOARDING_UPDATE]: request('updateOnboardingProgress', [z.unknown()]),
  [CHANNELS.APPLICATION_PROXY_DETECT]: request('detectApplicationProxyCandidates', []),
  [CHANNELS.APPLICATION_PROXY_GET]: request('getApplicationProxyState', []),
  [CHANNELS.APPLICATION_PROXY_SAVE]: request('saveApplicationProxy', [z.unknown()]),
  [CHANNELS.APPLICATION_PROXY_TEST]: request('testApplicationProxy', []),
  [CHANNELS.ARTIFACT_CREATE]: request('createArtifact', [z.unknown()]),
  [CHANNELS.ARTIFACT_DESTROY]: request('destroyArtifact', [z.unknown()]),
  [CHANNELS.ARTIFACT_GET_NETWORK_STATE]: request('getArtifactNetworkState', []),
  [CHANNELS.ARTIFACT_SET_NETWORK_ALLOWED]: request('setArtifactNetworkAllowed', [z.unknown()]),
  [CHANNELS.BUSY_LIST]: request('listBusyLeases', []),
  [CHANNELS.BUSY_SET_CONVERSATION]: request('setConversationBusy', [z.boolean()]),
  [CHANNELS.CHAT_DELETE_CONVERSATION]: request('deleteChatConversation', [z.unknown()]),
  [CHANNELS.CHAT_DELETE_DRAFT_ATTACHMENT]: request('deleteChatDraftAttachment', [
    z.unknown(),
    z.unknown(),
  ]),
  [CHANNELS.CHAT_GET_CONFIG]: request('getChatConfig', []),
  [CHANNELS.CHAT_GET_CONVERSATION]: request('getChatConversation', [z.unknown()]),
  [CHANNELS.CHAT_IMPORT_ATTACHMENT_BYTES]: request('importChatAttachmentBytes', [z.unknown()]),
  [CHANNELS.CHAT_IMPORT_ATTACHMENTS]: request('importChatAttachments', [z.unknown()]),
  [CHANNELS.CHAT_IMPORT_CLIPBOARD_IMAGE]: request('importChatClipboardImage', [z.unknown()]),
  [CHANNELS.CHAT_LIST_CONVERSATIONS]: request('getChatConversations', []),
  [CHANNELS.CHAT_PREFLIGHT]: request('preflightChat', [z.unknown()]),
  [CHANNELS.CHAT_READ_ATTACHMENT]: request('readChatAttachment', [z.unknown()]),
  [CHANNELS.CHAT_RELEASE_ATTACHMENT_DRAFT]: request('releaseChatAttachmentDraft', [z.unknown()]),
  [CHANNELS.CHAT_RENAME_CONVERSATION]: request('renameChatConversation', [
    z.unknown(),
    z.unknown(),
  ]),
  [CHANNELS.CHAT_SAVE_CONFIG]: request('saveChatConfig', [z.unknown()]),
  [CHANNELS.CHAT_SAVE_CONVERSATION]: request('saveChatConversation', [z.unknown()]),
  [CHANNELS.CHAT_START]: request('startChat', [z.unknown()]),
  [CHANNELS.CHAT_STOP]: request('stopChat', [z.unknown()]),
  [CHANNELS.CHAT_TEST_CONNECTION]: request('testChatConnection', [z.unknown()]),
  [CHANNELS.CLAUDE_COMMAND]: request('runClaudeCommand', [
    sessionIdSchema,
    z.string(),
    z.string().optional(),
  ]),
  [CHANNELS.CLAUDE_CONNECTION_HISTORY]: request('getClaudeConnectionHistory', [sessionIdSchema]),
  [CHANNELS.CLAUDE_CONNECTION_HISTORY_APPLY]: request('applyClaudeConnectionHistory', [
    sessionIdSchema,
    historyEntryIdSchema,
  ]),
  [CHANNELS.CLAUDE_CONNECTION_HISTORY_CANCEL_APPLY]: request('cancelClaudeConnectionHistoryApply', [
    sessionIdSchema,
  ]),
  [CHANNELS.CLAUDE_CONNECTION_HISTORY_DELETE]: request('deleteClaudeConnectionHistory', [
    sessionIdSchema,
    historyEntryIdSchema,
  ]),
  [CHANNELS.CLAUDE_CONNECTION_HISTORY_RENAME]: request('renameClaudeConnectionHistory', [
    sessionIdSchema,
    historyEntryIdSchema,
    z.string(),
  ]),
  [CHANNELS.CLAUDE_DELETE_SESSION]: request('deleteClaudeSession', [
    projectPathInputSchema,
    z.string(),
  ]),
  [CHANNELS.CLAUDE_EXECUTION_SETTINGS_GET]: request('getClaudeExecutionSettings', []),
  [CHANNELS.CLAUDE_EXECUTION_SETTINGS_UPDATE]: request('updateClaudeExecutionSettings', [
    claudeExecutionSettingsRequestSchema,
  ]),
  [CHANNELS.CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED]: request(
    'useRecommendedClaudeExecutionSettings',
    [],
  ),
  [CHANNELS.CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT]: request(
    'restoreClaudeExecutionSettingsDefault',
    [],
  ),
  [CHANNELS.CLAUDE_GET_CONNECTION_ADVICE]: request('getClaudeConnectionAdvice', [sessionIdSchema]),
  [CHANNELS.CLAUDE_GET_GATEWAY_DIAGNOSTICS]: request('getClaudeGatewayDiagnostics', [
    sessionIdSchema,
  ]),
  [CHANNELS.CLAUDE_GET_SESSIONS]: request('getClaudeSessions', [sessionIdSchema]),
  [CHANNELS.CLAUDE_GET_SESSIONS_FOR_PATH]: request('getClaudeSessionsForPath', [
    projectPathInputSchema,
  ]),
  [CHANNELS.CLAUDE_GET_STATE]: request('getClaudeProjectState', [sessionIdSchema]),
  [CHANNELS.CLAUDE_LAUNCH]: request('launchClaude', [sessionIdSchema, claudeLaunchModeSchema]),
  [CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE]: request('decideClaudeLaunchPreflight', [
    claudeLaunchPreflightDecisionInputSchema,
  ]),
  [CHANNELS.CLAUDE_LAUNCH_WITH_SESSION]: request('launchClaudeWithSession', [
    sessionIdSchema,
    z.string(),
  ]),
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_MODEL]: request('setManagedChatGptGatewayModel', [
    sessionIdSchema,
    z.string(),
  ]),
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_CANCEL_SETUP]: request(
    'cancelManagedChatGptGatewaySetup',
    [],
  ),
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_LOGOUT]: request('logoutManagedChatGptGateway', []),
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_OPEN_MANAGEMENT]: request(
    'openManagedChatGptGatewayManagement',
    [],
  ),
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP]: request('setupManagedChatGptGateway', [
    sessionIdSchema.optional(),
  ]),
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_GATEWAY_STATE]: request('getManagedChatGptGatewayState', []),
  [CHANNELS.CLAUDE_MODEL_OPTIONS]: request('getClaudeModelOptions', [sessionIdSchema]),
  [CHANNELS.CLAUDE_PERMISSION_RESPONSE]: request('respondClaudePermission', [
    z.string(),
    claudePermissionDecisionSchema,
  ]),
  [CHANNELS.CLAUDE_PLUGINS_GET]: request('getClaudePlugins', [z.unknown()]),
  [CHANNELS.CLAUDE_PLUGINS_INSTALL]: request('installClaudePlugin', [pluginIdSchema]),
  [CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_ADD]: request('addClaudePluginMarketplace', [z.unknown()]),
  [CHANNELS.CLAUDE_PLUGINS_MARKETPLACE_REMOVE]: request('removeClaudePluginMarketplace', [
    z.unknown(),
  ]),
  [CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_REFRESH]: request('refreshClaudePluginMarketplaces', []),
  [CHANNELS.CLAUDE_PLUGINS_SET_ENABLED]: request('setClaudePluginEnabled', [
    pluginIdSchema,
    z.boolean(),
  ]),
  [CHANNELS.CLAUDE_PLUGINS_UNINSTALL]: request('uninstallClaudePlugin', [pluginIdSchema]),
  [CHANNELS.CLAUDE_PLUGINS_UPDATE]: request('updateClaudePlugin', [pluginIdSchema]),
  [CHANNELS.CLAUDE_PLUGINS_UPDATE_ALL]: request('updateAllClaudePlugins', []),
  [CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER]: request('discoverClaudeProviderModels', [
    sessionIdSchema,
    providerModelDiscoveryInputSchema,
  ]),
  [CHANNELS.CLAUDE_RELAUNCH]: request('relaunchClaudeSession', [
    sessionIdSchema,
    claudeRelaunchInputSchema,
  ]),
  [CHANNELS.CLAUDE_RENAME_SESSION]: request('renameClaudeSession', [
    projectPathInputSchema,
    z.string(),
    z.string(),
  ]),
  [CHANNELS.CLAUDE_ROUTER_DELETE_PROVIDER]: request('deleteClaudeRouterProvider', [
    sessionIdSchema,
    z.string(),
  ]),
  [CHANNELS.CLAUDE_ROUTER_GET_STATE]: request('getClaudeRouterManagementState', [sessionIdSchema]),
  [CHANNELS.CLAUDE_ROUTER_INSTALL]: request('installClaudeRouter', [sessionIdSchema]),
  [CHANNELS.CLAUDE_ROUTER_INSTALL_SOURCE]: request('installClaudeRouterFromSource', [
    sessionIdSchema,
    z.unknown(),
  ]),
  [CHANNELS.CLAUDE_ROUTER_OPEN_MANAGEMENT]: request('openClaudeRouterManagement', [
    sessionIdSchema,
  ]),
  [CHANNELS.CLAUDE_ROUTER_REPAIR_FROM_PROJECT]: request('repairClaudeRouterFromProject', [
    sessionIdSchema,
  ]),
  [CHANNELS.CLAUDE_ROUTER_SAVE_PROVIDER]: request('saveClaudeRouterProvider', [
    sessionIdSchema,
    claudeRouterProviderInputSchema,
  ]),
  [CHANNELS.CLAUDE_ROUTER_START]: request('startClaudeRouter', [sessionIdSchema]),
  [CHANNELS.CLAUDE_ROUTER_STOP]: request('stopClaudeRouter', [sessionIdSchema]),
  [CHANNELS.CLAUDE_ROUTER_UNINSTALL]: request('uninstallClaudeRouter', [sessionIdSchema]),
  [CHANNELS.CLAUDE_SAVE_CONFIG]: request('saveClaudeConfig', [
    sessionIdSchema,
    claudeConfigInputSchema,
  ]),
  [CHANNELS.CLAUDE_SET_ALLOW_BYPASS_PERMISSIONS]: request('setClaudeAllowBypassPermissions', [
    sessionIdSchema,
    z.boolean(),
  ]),
  [CHANNELS.CLAUDE_SET_EFFORT]: request('setClaudeEffortLevel', [
    sessionIdSchema,
    claudeEffortRequestSchema,
  ]),
  [CHANNELS.CLAUDE_SET_MODEL_SPEED]: request('setClaudeModelSpeed', [
    sessionIdSchema,
    modelSpeedModeSchema,
  ]),
  [CHANNELS.CLAUDE_SET_PERMISSION_MODE]: request('setClaudePermissionMode', [
    sessionIdSchema,
    claudePermissionModeSchema,
  ]),
  [CHANNELS.CLAUDE_SWITCH_MODEL]: request('switchClaudeModel', [
    sessionIdSchema,
    modelOptionIdSchema,
  ]),
  [CHANNELS.CLAUDE_TEST_CONNECTION]: request('testClaudeConnection', [
    sessionIdSchema,
    claudeConfigInputSchema,
  ]),
  [CHANNELS.CODEX_GET_STATE]: request('getCodexProjectState', [sessionIdSchema]),
  [CHANNELS.CODEX_INSTALL_UPDATE]: request('installOrUpdateCodex', [
    sessionIdSchema,
    codexInstallOperationSchema,
  ]),
  [CHANNELS.CODEX_LAUNCH]: request('launchCodex', [sessionIdSchema, codexLaunchModeSchema]),
  [CHANNELS.CODEX_LOGIN_CANCEL]: request('cancelCodexLogin', [sessionIdSchema]),
  [CHANNELS.CODEX_LOGIN_START]: request('startCodexLogin', [
    sessionIdSchema,
    codexLoginMethodSchema,
  ]),
  [CHANNELS.CODEX_LOGOUT]: request('logoutCodex', [sessionIdSchema]),
  [CHANNELS.DIRECTORY_CHOOSE]: request('chooseDirectory', []),
  [CHANNELS.DOWNLOAD_CANCEL]: request('cancelDownload', [downloadTaskIdSchema]),
  [CHANNELS.DOWNLOAD_HISTORY_CLEAR]: request('clearDownloadHistory', []),
  [CHANNELS.DOWNLOAD_HISTORY_DELETE]: request('deleteDownloadHistory', [downloadTaskIdSchema]),
  [CHANNELS.DOWNLOAD_LIST]: request('listDownloads', []),
  [CHANNELS.DOWNLOAD_PAUSE]: request('pauseDownload', [downloadTaskIdSchema]),
  [CHANNELS.DOWNLOAD_RESUME]: request('resumeDownload', [downloadTaskIdSchema]),
  [CHANNELS.MARKDOWN_OPEN_EXTERNAL]: request('openMarkdownExternal', [
    markdownExternalUrlInputSchema,
  ]),
  [CHANNELS.MCP_BACKUP_RESTORE]: request('restoreMcpBackup', [z.string(), projectPathInputSchema]),
  [CHANNELS.MCP_BACKUPS]: request('getMcpBackups', []),
  [CHANNELS.MCP_GET_CATALOG]: request('getMcpCatalog', [projectPathInputSchema, z.boolean()]),
  [CHANNELS.MCP_INSTALL]: request('installMcpServer', [mcpInstallInputSchema]),
  [CHANNELS.MCP_REMOVE]: request('removeMcpServer', [mcpRemoveInputSchema]),
  [CHANNELS.MCP_TOGGLE_APPLY]: request('applyMcpToggle', [z.string(), projectPathInputSchema]),
  [CHANNELS.MCP_TOGGLE_DISCARD]: request('discardMcpToggle', [z.string()]),
  [CHANNELS.MCP_TOGGLE_PREVIEW]: request('previewMcpToggle', [
    projectPathInputSchema,
    z.string(),
    z.boolean(),
  ]),
  [CHANNELS.NATIVE_ATTACHMENT_IMPORT_BYTES]: request('importNativeAttachmentBytes', [
    conversationIdSchema,
    z.unknown(),
  ]),
  [CHANNELS.NATIVE_ATTACHMENT_IMPORT_CLIPBOARD]: request('importNativeClipboardImage', [
    conversationIdSchema,
  ]),
  [CHANNELS.NATIVE_ATTACHMENT_IMPORT_PATHS]: request('importNativeAttachmentPaths', [
    conversationIdSchema,
    z.array(z.string()),
  ]),
  [CHANNELS.NATIVE_ATTACHMENT_READ]: request('readNativeAttachment', [
    conversationIdSchema,
    conversationIdSchema,
  ]),
  [CHANNELS.NATIVE_ATTACHMENT_REMOVE]: request('removeNativeAttachment', [
    conversationIdSchema,
    conversationIdSchema,
  ]),
  [CHANNELS.NATIVE_CONVERSATION_ADOPT_TERMINAL]: request('adoptTerminalConversation', [
    sessionIdSchema,
    z.boolean(),
  ]),
  [CHANNELS.NATIVE_CONVERSATION_CLOSE]: request('closeNativeConversation', [conversationIdSchema]),
  [CHANNELS.NATIVE_CONVERSATION_DISCARD_RECOVERY]: request('discardNativeRecovery', [
    conversationIdSchema,
    projectPathInputSchema,
  ]),
  [CHANNELS.NATIVE_CONVERSATION_GET]: request('getNativeConversation', [conversationIdSchema]),
  [CHANNELS.NATIVE_CONVERSATION_INTERRUPT]: request('interruptNativeConversation', [
    conversationIdSchema,
  ]),
  [CHANNELS.NATIVE_CONVERSATION_LIST_RECOVERIES]: request('listNativeRecoveries', []),
  [CHANNELS.NATIVE_CONVERSATION_RENAME]: request('renameNativeConversation', [
    conversationIdSchema,
    z.string(),
  ]),
  [CHANNELS.NATIVE_CONVERSATION_RESPOND]: request('respondNativeConversation', [
    conversationIdSchema,
    z.string(),
    nativeInteractionResponseSchema,
  ]),
  [CHANNELS.NATIVE_CONVERSATION_RESTORE_DRAFT]: request('restoreNativeDraft', [
    conversationIdSchema,
    z.string(),
    projectPathInputSchema,
  ]),
  [CHANNELS.NATIVE_CONVERSATION_START]: request('startNativeConversation', [z.unknown()]),
  [CHANNELS.NATIVE_CONVERSATION_STOP_TASK]: request('stopNativeConversationTask', [
    conversationIdSchema,
    z.string(),
  ]),
  [CHANNELS.NATIVE_CONVERSATION_SUBMIT]: request('submitNativeConversation', [
    conversationIdSchema,
    nativeSubmitInputSchema,
  ]),
  [CHANNELS.NATIVE_CONVERSATION_TRANSFER_TO_TERMINAL]: request(
    'transferNativeConversationToTerminal',
    [conversationIdSchema, nativeSubmitInputSchema.optional(), z.boolean()],
  ),
  [CHANNELS.NATIVE_CONVERSATION_UPDATE_CONTROLS]: request('updateNativeConversationControls', [
    conversationIdSchema,
    nativeControlUpdateSchema,
  ]),
  [CHANNELS.NETWORK_PREFLIGHT_CLEAR_HISTORY]: request('clearNetworkPreflightHistory', []),
  [CHANNELS.NETWORK_PREFLIGHT_GET]: request('getNetworkPreflight', [networkProviderSchema]),
  [CHANNELS.NETWORK_PREFLIGHT_GET_HISTORY]: request('getNetworkPreflightHistory', []),
  [CHANNELS.NETWORK_PREFLIGHT_INVALIDATE]: request('invalidateNetworkPreflight', [z.string()]),
  [CHANNELS.NETWORK_PREFLIGHT_RUN]: request('runNetworkPreflight', [
    networkPreflightRunInputSchema,
  ]),
  [CHANNELS.PROJECT_ACTIVATE]: request('activateProject', [sessionIdSchema]),
  [CHANNELS.PROJECT_ADD]: request('addProject', [projectPathInputSchema]),
  [CHANNELS.PROJECT_CLOSE]: request('closeProject', [sessionIdSchema]),
  [CHANNELS.PROJECT_CLOSE_FOLDER]: request('closeProjectFolder', [projectPathInputSchema]),
  [CHANNELS.PROJECT_FORGET]: request('forgetProject', [projectPathInputSchema]),
  [CHANNELS.PROJECT_OPEN_CONVERSATION]: request('openConversation', [projectPathInputSchema]),
  [CHANNELS.PROJECT_OPEN_STORED_CONVERSATION]: request('openStoredConversation', [
    projectPathInputSchema,
    z.string(),
  ]),
  [CHANNELS.PROJECT_RENAME_CONVERSATION]: request('renameConversation', [
    sessionIdSchema,
    z.string(),
  ]),
  [CHANNELS.ROUTER_CC_SWITCH_EXPORT_CURRENT]: request('exportCurrentProviderToCcSwitch', [
    sessionIdSchema,
  ]),
  [CHANNELS.ROUTER_CC_SWITCH_INSTALL]: request('installCcSwitch', [sessionIdSchema]),
  [CHANNELS.ROUTER_CC_SWITCH_UNINSTALL]: request('uninstallCcSwitch', [sessionIdSchema]),
  [CHANNELS.ROUTER_KERNEL_STATE]: request('getRouterKernelState', [sessionIdSchema]),
  [CHANNELS.RUNTIME_GET]: request('getDevelopmentRuntime', [sessionIdSchema]),
  [CHANNELS.RUNTIME_GET_ACTIVITY]: request('getRuntimeActivity', [sessionIdSchema]),
  [CHANNELS.RUNTIME_SET]: request('setDevelopmentRuntime', [
    sessionIdSchema,
    developmentRuntimeSchema,
  ]),
  [CHANNELS.RUNTIME_TERMINATE_PROCESS]: request('terminateRuntimeProcess', [
    sessionIdSchema,
    z.string(),
  ]),
  [CHANNELS.SOFTWARE_APPLICATION_UPDATER_DOWNLOAD]: request('downloadApplicationUpdate', []),
  [CHANNELS.SOFTWARE_APPLICATION_UPDATER_GET]: request('getApplicationUpdaterState', [
    z.boolean().optional(),
  ]),
  [CHANNELS.SOFTWARE_APPLICATION_UPDATER_INSTALL]: request('installApplicationUpdate', []),
  [CHANNELS.SOFTWARE_CLAUDE_INSTALL_UPDATE]: request('installOrUpdateClaudeCode', []),
  [CHANNELS.SOFTWARE_UPDATES_GET]: request('getSoftwareUpdates', [z.unknown()]),
  [CHANNELS.TERMINAL_RESTART]: request('restartTerminal', [sessionIdSchema, ptyGenerationSchema]),
  [CHANNELS.TERMINAL_START]: request('startTerminal', [sessionIdSchema, ptyGenerationSchema]),
  [CHANNELS.TERMINAL_STOP]: request('stopTerminal', [sessionIdSchema, ptyGenerationSchema]),
  [CHANNELS.UI_SET_THEME]: request('setAppTheme', [z.unknown()]),
  [CHANNELS.WORKSPACE_GET_STATE]: request('getWorkspace', []),
  [CHANNELS.WORKSPACE_GET_STORED_PROJECTS]: request('getStoredProjects', []),
  [CHANNELS.WORKSPACE_REMOVE_STORED_PROJECT]: request('removeStoredProject', [z.unknown()]),
} as const satisfies Record<RequestChannel, IpcRequestDefinition<RequestMethod>>;

export const IPC_SEND_METHODS = {
  [CHANNELS.APP_CONFIRM_QUIT]: 'confirmQuit',
  [CHANNELS.APP_MINIMIZE_TO_TRAY]: 'minimizeToTray',
  [CHANNELS.APP_QUIT_REQUEST_RECEIVED]: 'onAppQuitRequested',
  [CHANNELS.CLAUDE_PERMISSION_MODE_OBSERVED]: 'observeClaudePermissionMode',
  [CHANNELS.CLAUDE_PERMISSION_MODE_PROBE_RESULT]: 'reportClaudePermissionModeProbe',
  [CHANNELS.TERMINAL_RESIZE]: 'resizeTerminal',
  [CHANNELS.TERMINAL_WRITE]: 'writeTerminal',
} as const satisfies Record<SendChannel, keyof ControlPanelApi>;

export const IPC_EVENT_METHODS = {
  [CHANNELS.APP_OPEN_DOWNLOAD_CENTER]: 'onOpenDownloadCenterRequested',
  [CHANNELS.APP_QUIT_REQUESTED]: 'onAppQuitRequested',
  [CHANNELS.APP_QUIT_REQUEST_INVALIDATED]: 'onAppQuitRequestInvalidated',
  [CHANNELS.APP_WINDOW_RESTORED]: 'onAppWindowRestored',
  [CHANNELS.APPLICATION_PROXY_CHANGED]: 'onApplicationProxyChanged',
  [CHANNELS.ARTIFACT_NETWORK_LOG]: 'onArtifactNetworkLog',
  [CHANNELS.BUSY_CHANGED]: 'onBusyChanged',
  [CHANNELS.CHAT_STREAM]: 'onChatStream',
  [CHANNELS.CLAUDE_MANAGED_CHATGPT_SETUP_PROGRESS]: 'onManagedChatGptSetupProgress',
  [CHANNELS.CLAUDE_PERMISSION_MODE_PROBE]: 'onClaudePermissionModeProbe',
  [CHANNELS.CLAUDE_PERMISSION_REQUEST]: 'onClaudePermissionRequest',
  [CHANNELS.CLAUDE_STATE]: 'onClaudeState',
  [CHANNELS.CODEX_STATE]: 'onCodexState',
  [CHANNELS.CONVERSATION_OWNER_CONFLICT]: 'onConversationOwnerConflict',
  [CHANNELS.DOWNLOAD_CHANGED]: 'onDownloadsChanged',
  [CHANNELS.NATIVE_CONVERSATION_SNAPSHOT]: 'onNativeConversation',
  [CHANNELS.NETWORK_PREFLIGHT_RESULT]: 'onNetworkPreflight',
  [CHANNELS.ROUTER_OPERATION_PROGRESS]: 'onRouterOperationProgress',
  [CHANNELS.RUNTIME_ACTIVITY_CHANGED]: 'onRuntimeActivityChanged',
  [CHANNELS.SOFTWARE_APPLICATION_UPDATER_CHANGED]: 'onApplicationUpdaterChanged',
  [CHANNELS.TERMINAL_DATA]: 'onTerminalData',
  [CHANNELS.TERMINAL_SIZE]: 'onTerminalSize',
  [CHANNELS.WORKSPACE_STATE]: 'onWorkspaceState',
} as const satisfies Record<EventChannel, keyof ControlPanelApi>;

export type IpcRequestChannel = keyof typeof IPC_REQUESTS;
export type IpcRequestMethod<C extends IpcRequestChannel> = (typeof IPC_REQUESTS)[C]['method'];
export type IpcRequestArgs<C extends IpcRequestChannel> = z.output<
  (typeof IPC_REQUESTS)[C]['args']
>;
export type IpcRequestResult<C extends IpcRequestChannel> = Awaited<
  ReturnType<ControlPanelApi[IpcRequestMethod<C>]>
>;

export const parseIpcRequestArgs = <C extends IpcRequestChannel>(
  channel: C,
  args: unknown[],
): IpcRequestArgs<C> => IPC_REQUESTS[channel].args.parse(args) as IpcRequestArgs<C>;
