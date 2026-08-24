import path from 'node:path';
import { release } from 'node:os';
import type { ZodType } from 'zod';
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
} from '../../shared/contracts';
import type {
  ConversationControlUpdate,
  ConversationInteractionResponse,
  ConversationSubmitInput,
} from '../../shared/conversation/native';
import {
  claudeConfigInputSchema,
  claudeEffortRequestSchema,
  claudeLaunchModeSchema,
  claudeLaunchPreflightDecisionInputSchema,
  claudePermissionDecisionSchema,
  claudePermissionModeSchema,
  claudeRelaunchInputSchema,
  claudeRouterProviderInputSchema,
  codexInstallOperationSchema,
  codexLaunchModeSchema,
  codexLoginMethodSchema,
  conversationIdSchema,
  developmentRuntimeSchema,
  downloadTaskIdSchema,
  externalUrlInputSchema,
  historyEntryIdSchema,
  markdownExternalUrlInputSchema,
  mcpInstallInputSchema,
  mcpRemoveInputSchema,
  mcpScopeSchema,
  modelOptionIdSchema,
  modelSpeedModeSchema,
  nativeControlUpdateSchema,
  nativeInteractionResponseObjectSchema,
  nativeInteractionResponseSchema,
  nativeSubmitInputSchema,
  networkPreflightActionSchema,
  networkPreflightRunInputSchema,
  networkProviderSchema,
  pluginIdSchema,
  projectPathInputSchema,
  providerModelDiscoveryInputSchema,
  ptyGenerationSchema,
  sessionIdSchema,
} from '../../shared/ipc/schema';
import { CLAUDE_PROVIDER_EXTERNAL_HOSTS } from '../../shared/claude/providers';

const parseSchema = <Output>(schema: ZodType<Output>, value: unknown): Output => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? 'IPC 参数无效。');
  }
  return result.data;
};

export const validateSessionId = (sessionId: unknown): string =>
  parseSchema(sessionIdSchema, sessionId);

export const validatePtyGeneration = (value: unknown): PtyGeneration =>
  parseSchema(ptyGenerationSchema, value);

export const validateConversationId = (value: unknown): string =>
  parseSchema(conversationIdSchema, value);

export const validateNativeSubmitInput = (value: unknown): ConversationSubmitInput =>
  parseSchema(nativeSubmitInputSchema, value);

export const validateNativeInteractionResponse = (
  value: unknown,
): ConversationInteractionResponse => {
  const response = parseSchema(nativeInteractionResponseObjectSchema, value);
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    throw new Error('原生交互响应过大。');
  }
  return parseSchema(nativeInteractionResponseSchema, response);
};

export const validateNativeControlUpdate = (value: unknown): ConversationControlUpdate =>
  parseSchema(nativeControlUpdateSchema, value);

export const validateDownloadTaskId = (taskId: unknown): string =>
  parseSchema(downloadTaskIdSchema, taskId);

export const validateDevelopmentRuntime = (value: unknown): DevelopmentRuntime =>
  parseSchema(developmentRuntimeSchema, value);

export const validateNetworkProvider = (value: unknown): NetworkProviderId =>
  parseSchema(networkProviderSchema, value);

export const validateNetworkPreflightAction = (value: unknown): NetworkPreflightAction =>
  parseSchema(networkPreflightActionSchema, value);

export const validateNetworkPreflightRunInput = (value: unknown): NetworkPreflightRunInput => {
  const input = parseSchema(networkPreflightRunInputSchema, value);
  return input.cwd === undefined ? input : { ...input, cwd: path.resolve(input.cwd) };
};

export const validateClaudeLaunchMode = (mode: unknown): ClaudeLaunchMode =>
  parseSchema(claudeLaunchModeSchema, mode);

export const validateClaudeLaunchPreflightDecisionInput = (
  input: unknown,
): ClaudeLaunchPreflightDecisionInput =>
  parseSchema(claudeLaunchPreflightDecisionInputSchema, input);

export const validateCodexLaunchMode = (mode: unknown): CodexLaunchMode =>
  parseSchema(codexLaunchModeSchema, mode);

export const validateCodexLoginMethod = (method: unknown): CodexLoginMethod =>
  parseSchema(codexLoginMethodSchema, method);

export const validateCodexInstallOperation = (operation: unknown): CodexInstallOperation =>
  parseSchema(codexInstallOperationSchema, operation);

export const validateClaudePermissionMode = (mode: unknown): ClaudePermissionMode =>
  parseSchema(claudePermissionModeSchema, mode);

export const validateClaudeEffortRequest = (effort: unknown): ClaudeEffortRequest =>
  parseSchema(claudeEffortRequestSchema, effort);

export const validateModelSpeedMode = (mode: unknown): ModelSpeedMode =>
  parseSchema(modelSpeedModeSchema, mode);

/** Option identifiers are minted by getModelOptions; anything else never reaches the terminal. */
export const validateModelOptionId = (value: unknown): string =>
  parseSchema(modelOptionIdSchema, value);

export const validateClaudeRelaunchInput = (input: unknown): ClaudeRelaunchInput =>
  parseSchema(claudeRelaunchInputSchema, input);

export const validateClaudeConfigInput = (input: unknown): SaveClaudeConfigInput =>
  parseSchema(claudeConfigInputSchema, input);

export const validateClaudeRouterProviderInput = (input: unknown): SaveClaudeRouterProviderInput =>
  parseSchema(claudeRouterProviderInputSchema, input);

export const allowedExternalHosts = new Set([
  ...CLAUDE_PROVIDER_EXTERNAL_HOSTS,
  'api-docs.deepseek.com',
  'ccrdesk.top',
  'code.claude.com',
  'docs.litellm.ai',
  'github.com',
  'musistudio.github.io',
]);

export const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export const validateHistoryEntryId = (value: unknown): string =>
  parseSchema(historyEntryIdSchema, value);

export const validateExternalUrl = (value: unknown): string => {
  const input = parseSchema(externalUrlInputSchema, value);
  const parsed = new URL(input);
  const hostname = parsed.hostname.toLowerCase();
  const allowedHttps = parsed.protocol === 'https:' && allowedExternalHosts.has(hostname);
  const allowedLoopback =
    parsed.protocol === 'http:' && loopbackHosts.has(hostname) && parsed.port === '3458';
  if (
    (!allowedHttps && !allowedLoopback) ||
    parsed.username ||
    parsed.password ||
    parsed.protocol === 'file:'
  ) {
    throw new Error('该链接不在 ClaudeDock 允许打开的帮助或本机管理地址中。');
  }
  return parsed.toString();
};

export const validateMarkdownExternalUrl = (value: unknown): string => {
  const input = parseSchema(markdownExternalUrlInputSchema, value);
  const parsed = new URL(input);
  if (
    (parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'mailto:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('只允许打开 HTTP、HTTPS 或邮件链接。');
  }
  return parsed.toString();
};

export const validatePluginId = (value: unknown): string => parseSchema(pluginIdSchema, value);

export const validateMcpScope = (value: unknown): McpScope => parseSchema(mcpScopeSchema, value);

export const validateProjectPath = (value: unknown): string =>
  path.resolve(parseSchema(projectPathInputSchema, value));

export const validateMcpInstallInput = (value: unknown): McpInstallInput => {
  const input = parseSchema(mcpInstallInputSchema, value);
  return { ...input, cwd: path.resolve(input.cwd) };
};

export const validateMcpRemoveInput = (value: unknown): McpRemoveInput => {
  const input = parseSchema(mcpRemoveInputSchema, value);
  return { ...input, cwd: path.resolve(input.cwd) };
};

export const validateProviderModelDiscoveryInput = (
  value: unknown,
): ClaudeProviderModelDiscoveryInput => parseSchema(providerModelDiscoveryInputSchema, value);

export const validateClaudePermissionDecision = (value: unknown): ClaudePermissionDecision =>
  parseSchema(claudePermissionDecisionSchema, value);

export const windowsBuildNumber = (): number => {
  const value = Number(release().split('.')[2]);
  return Number.isInteger(value) && value > 0 ? value : 0;
};
