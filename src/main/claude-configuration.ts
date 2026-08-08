import path from 'node:path';
import type {
  ClaudeInstallationStatus,
  ClaudeLaunchMode,
  ClaudePermissionMode,
  ManagedChatGptContextWindowMode,
  ModelSpeedMechanism,
  ModelSpeedMode,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import { normalizeConnectionBaseUrl } from '../shared/connection-endpoint';
import { findClaudeProvider, providerForPreset } from '../shared/claude-providers';
import {
  blockingVersionRuleFor,
  compareSemanticVersions,
  getProviderProfile,
} from '../shared/provider-profiles';

export interface NormalizedClaudeConfig {
  apiKeyHelperPolicy: NonNullable<SaveClaudeConfigInput['apiKeyHelperPolicy']>;
  authMode: SaveClaudeConfigInput['authMode'];
  baseUrl: string;
  model: string;
  modelFast?: string;
  preset: SaveClaudeConfigInput['preset'];
  provider: SaveClaudeConfigInput['provider'];
}

export type ClaudeEnvironmentOverrides = Record<string, null | string>;

export const DEFAULT_CLAUDE_CONFIG: NormalizedClaudeConfig = {
  apiKeyHelperPolicy: 'prefer-claudedock',
  authMode: 'existing',
  baseUrl: '',
  model: 'default',
  modelFast: 'default',
  preset: 'anthropic',
  provider: 'anthropic',
};

export const CLAUDE_ROUTE_ALIAS_ENVIRONMENT_KEYS = [
  'ANTHROPIC_API_BASE_URL',
  'CLAUDE_AGENT_API_BASE_URL',
  'CCR_CLAUDE_CODE_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CODEXL_CLAUDE_CODE_MODEL',
] as const;

export const MANAGED_CLAUDE_ENVIRONMENT_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
  'MAX_THINKING_TOKENS',
  ...CLAUDE_ROUTE_ALIAS_ENVIRONMENT_KEYS,
] as const;

/**
 * The managed ChatGPT bridge exposes a non-Claude model name, so Claude Code cannot infer its
 * context capacity. Codex currently exposes 272k raw tokens and reserves 5%, which its UI reports
 * as about 258.4k usable. Keep the raw window explicit, but calculate automatic compaction against
 * that effective window. 258.4k x 80% starts around 206.7k and leaves enough headroom for a large
 * tool or subagent result before the upstream hard limit.
 */
export const MANAGED_CHATGPT_CONTEXT_WINDOW_TOKENS = 272_000;
export const MANAGED_CHATGPT_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 258_400;
export const MANAGED_CHATGPT_AUTO_COMPACT_PERCENT = 80;
export const MANAGED_CHATGPT_EXTENDED_CONTEXT_WINDOW_TOKENS = 1_050_000;
export const MANAGED_CHATGPT_EXTENDED_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 997_500;

export interface ManagedChatGptContextProfile {
  autoCompactAtTokens: number;
  autoCompactPercent: number;
  contextWindowTokens: number;
  effectiveContextWindowTokens: number;
  mode: ManagedChatGptContextWindowMode;
}

export const managedChatGptContextProfile = (
  config: NormalizedClaudeConfig,
  mode: ManagedChatGptContextWindowMode = 'standard',
): ManagedChatGptContextProfile | undefined => {
  if (!usesManagedChatGptCodexContextProfile(config)) return undefined;
  const contextWindowTokens =
    mode === 'extended'
      ? MANAGED_CHATGPT_EXTENDED_CONTEXT_WINDOW_TOKENS
      : MANAGED_CHATGPT_CONTEXT_WINDOW_TOKENS;
  const effectiveContextWindowTokens =
    mode === 'extended'
      ? MANAGED_CHATGPT_EXTENDED_EFFECTIVE_CONTEXT_WINDOW_TOKENS
      : MANAGED_CHATGPT_EFFECTIVE_CONTEXT_WINDOW_TOKENS;
  return {
    autoCompactAtTokens:
      (effectiveContextWindowTokens * MANAGED_CHATGPT_AUTO_COMPACT_PERCENT) / 100,
    autoCompactPercent: MANAGED_CHATGPT_AUTO_COMPACT_PERCENT,
    contextWindowTokens,
    effectiveContextWindowTokens,
    mode,
  };
};

const managedChatGptContextEnvironment = (
  config: NormalizedClaudeConfig,
  mode: ManagedChatGptContextWindowMode,
): Record<string, string> => {
  const profile = managedChatGptContextProfile(config, mode);
  if (!profile) return {};
  return {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(profile.autoCompactPercent),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(profile.effectiveContextWindowTokens),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(profile.contextWindowTokens),
  };
};

export const usesManagedChatGptCodexContextProfile = (config: NormalizedClaudeConfig): boolean =>
  config.preset === 'chatgpt-subscription' &&
  (config.model.toLowerCase() === 'gpt-5.6-sol' || config.model.toLowerCase() === 'gpt-5.6');

export const MODEL_NAME_PATTERN = /^[-A-Za-z0-9._:/@[\]~]{1,200}$/;
const LOOPBACK_GATEWAY_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
export const parseClaudeVersion = (output: string): [number, number, number] | undefined => {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output);
  if (!match) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const detectClaudeInstallationKind = (
  executable?: string,
): ClaudeInstallationStatus['installationKind'] => {
  const normalized = executable?.replaceAll('\\', '/').toLowerCase() ?? '';
  if (!normalized) {
    return 'unknown';
  }
  if (
    normalized.endsWith('.cmd') ||
    normalized.endsWith('.ps1') ||
    normalized.includes('/node_modules/') ||
    normalized.includes('/npm/')
  ) {
    return 'npm';
  }
  return normalized.endsWith('.exe') ? 'native' : 'unknown';
};

export const evaluateClaudeInstallation = (
  output: string,
  executable?: string,
): ClaudeInstallationStatus => {
  const installationKind = detectClaudeInstallationKind(executable);
  const version = parseClaudeVersion(output);
  if (!version) {
    return {
      executable,
      installationKind,
      installed: true,
      message: '已找到 Claude Code，但无法识别版本；受保护启动已停用。',
      security: 'unknown',
    };
  }

  const versionText = version.join('.');
  const policy = getProviderProfile('anthropic-claude');
  const blockingRule = blockingVersionRuleFor(policy, versionText);
  if (blockingRule) {
    return {
      executable,
      installationKind,
      installed: true,
      message: `版本 ${versionText} 命中安全规则：${blockingRule.reason}`,
      security: 'blocked-version',
      version: versionText,
    };
  }

  if (
    policy.minimumSecureClientVersion &&
    compareSemanticVersions(versionText, policy.minimumSecureClientVersion) < 0
  ) {
    return {
      executable,
      installationKind,
      installed: true,
      message: `版本 ${versionText} 过旧；受保护启动要求 ${policy.minimumSecureClientVersion} 或更高版本。`,
      security: 'update-required',
      version: versionText,
    };
  }

  return {
    executable,
    installationKind,
    installed: true,
    message: `Claude Code ${versionText} 已通过已知风险版本检查。`,
    security: 'ready',
    version: versionText,
  };
};

/**
 * Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL` itself, so the stored value stays the
 * base the relay published — including a trailing `/v1`, which several relays require.
 */
const normalizeBaseUrl = (value: string): string => normalizeConnectionBaseUrl(value);

export const normalizeClaudeConfig = (input: SaveClaudeConfigInput): NormalizedClaudeConfig => {
  const apiKeyHelperPolicy =
    input.apiKeyHelperPolicy === 'inherit' ? 'inherit' : 'prefer-claudedock';
  const model = input.model.trim();
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new Error('模型标识只能包含字母、数字以及 . _ : / @ [ ] ~ -。');
  }
  const modelFast = input.modelFast?.trim() || model;
  if (!MODEL_NAME_PATTERN.test(modelFast)) {
    throw new Error('小型/备用模型标识只能包含字母、数字以及 . _ : / @ [ ] ~ -。');
  }

  const providerDefinition = findClaudeProvider(input.preset);
  const preset = providerDefinition?.id ?? 'custom';
  const provider = providerForPreset(preset);
  if (input.provider !== provider) {
    throw new Error('服务商预设与连接类型不一致。');
  }

  if (provider === 'anthropic') {
    if (input.authMode !== 'existing' && input.authMode !== 'apiKey') {
      throw new Error('Anthropic 官方接入只能使用现有登录或接口密钥。');
    }
    return {
      apiKeyHelperPolicy,
      authMode: input.authMode,
      baseUrl: '',
      model,
      modelFast,
      preset,
      provider: 'anthropic',
    };
  }

  if (input.authMode !== 'apiKey' && input.authMode !== 'authToken' && input.authMode !== 'none') {
    throw new Error('中转接入的认证方式无效。');
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (
    preset === 'chatgpt-subscription' &&
    !LOOPBACK_GATEWAY_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  ) {
    throw new Error('ChatGPT 订阅转换只接受本机回环网关地址。');
  }
  if (preset === 'chatgpt-subscription' && input.authMode !== 'authToken') {
    throw new Error('ChatGPT 订阅转换必须使用本地网关 Bearer Token。');
  }

  return {
    apiKeyHelperPolicy,
    authMode: input.authMode,
    baseUrl,
    model,
    modelFast,
    preset,
    provider: 'gateway',
  };
};

/**
 * Claude Code merges `--settings` above user/project settings. An empty helper is treated as
 * unset by the CLI, so an explicit ClaudeDock credential remains the only credential source
 * without editing the user's `~/.claude/settings.json`.
 */
export const shouldDisableInheritedApiKeyHelper = (config: NormalizedClaudeConfig): boolean =>
  config.apiKeyHelperPolicy === 'prefer-claudedock' &&
  (config.authMode === 'apiKey' || config.authMode === 'authToken');

export interface ClaudeServingSpeedProfile {
  mechanism: ModelSpeedMechanism;
  mode: ModelSpeedMode;
}

export const STANDARD_CLAUDE_SPEED_PROFILE: ClaudeServingSpeedProfile = {
  mechanism: 'none',
  mode: 'standard',
};

export const buildClaudeSpeedSettings = (
  speed: ClaudeServingSpeedProfile = STANDARD_CLAUDE_SPEED_PROFILE,
): { fastMode: boolean; fastModePerSessionOptIn: boolean } => {
  const nativeFast = speed.mode === 'fast' && speed.mechanism === 'claude-native-fast';
  return {
    fastMode: nativeFast,
    fastModePerSessionOptIn: !nativeFast,
  };
};

const applyServingSpeedEnvironment = (
  environment: ClaudeEnvironmentOverrides,
  speed: ClaudeServingSpeedProfile,
): void => {
  if (speed.mode === 'fast' && speed.mechanism === 'claude-native-fast') {
    // Claude Code must perform its normal organization, credit, and model eligibility checks.
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = null;
  }
  if (speed.mode === 'fast' && speed.mechanism === 'gpt-service-tier') {
    environment.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ service_tier: 'fast' });
  }
};

export const buildClaudeEnvironment = (
  config: NormalizedClaudeConfig,
  credential?: string,
  contextWindowMode: ManagedChatGptContextWindowMode = 'standard',
  speed: ClaudeServingSpeedProfile = STANDARD_CLAUDE_SPEED_PROFILE,
): ClaudeEnvironmentOverrides => {
  const environment: ClaudeEnvironmentOverrides = {};
  for (const key of MANAGED_CLAUDE_ENVIRONMENT_KEYS) {
    environment[key] = null;
  }

  Object.assign(environment, {
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  });

  const effectiveCredential = credential || (config.preset === 'ollama' ? 'ollama' : undefined);
  if (config.authMode === 'apiKey' && effectiveCredential) {
    environment.ANTHROPIC_API_KEY = effectiveCredential;
  } else if (config.authMode === 'authToken' && effectiveCredential) {
    environment.ANTHROPIC_AUTH_TOKEN = effectiveCredential;
  }

  environment.ANTHROPIC_MODEL = config.model;

  if (config.provider === 'gateway' || config.model !== 'default') {
    const fastModel = config.modelFast || config.model;
    environment.ANTHROPIC_CUSTOM_MODEL_OPTION = config.model;
    environment.ANTHROPIC_DEFAULT_HAIKU_MODEL = fastModel;
    environment.ANTHROPIC_DEFAULT_OPUS_MODEL = config.model;
    environment.ANTHROPIC_DEFAULT_SONNET_MODEL = config.model;
    environment.ANTHROPIC_SMALL_FAST_MODEL = fastModel;
  }

  if (config.provider === 'gateway') {
    environment.ANTHROPIC_BASE_URL = config.baseUrl;
    environment.DISABLE_AUTOUPDATER = '1';
  }

  Object.assign(environment, managedChatGptContextEnvironment(config, contextWindowMode));
  applyServingSpeedEnvironment(environment, speed);

  return environment;
};

export const buildClaudeSettingsEnvironment = (
  config: NormalizedClaudeConfig,
  contextWindowMode: ManagedChatGptContextWindowMode = 'standard',
  speed: ClaudeServingSpeedProfile = STANDARD_CLAUDE_SPEED_PROFILE,
): Record<string, string> => {
  const desiredCredentialKey =
    config.authMode === 'apiKey'
      ? 'ANTHROPIC_API_KEY'
      : config.authMode === 'authToken'
        ? 'ANTHROPIC_AUTH_TOKEN'
        : undefined;
  const environment: Record<string, string> = {};
  for (const key of MANAGED_CLAUDE_ENVIRONMENT_KEYS) {
    if (key !== desiredCredentialKey) {
      environment[key] = '';
    }
  }

  environment.ANTHROPIC_MODEL = config.model;
  if (config.provider === 'gateway' || config.model !== 'default') {
    const fastModel = config.modelFast || config.model;
    environment.ANTHROPIC_CUSTOM_MODEL_OPTION = config.model;
    environment.ANTHROPIC_DEFAULT_HAIKU_MODEL = fastModel;
    environment.ANTHROPIC_DEFAULT_OPUS_MODEL = config.model;
    environment.ANTHROPIC_DEFAULT_SONNET_MODEL = config.model;
    environment.ANTHROPIC_SMALL_FAST_MODEL = fastModel;
  }
  if (config.provider === 'gateway') {
    environment.ANTHROPIC_BASE_URL = config.baseUrl;
  }

  Object.assign(environment, managedChatGptContextEnvironment(config, contextWindowMode));
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
    speed.mode === 'fast' && speed.mechanism === 'claude-native-fast' ? '' : '1';
  if (speed.mode === 'fast' && speed.mechanism === 'gpt-service-tier') {
    environment.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ service_tier: 'fast' });
  }

  return environment;
};

const quotePowerShellArgument = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Windows PowerShell 5 removes unescaped JSON quotes while rebuilding a native command line.
 * Escape every quote and double the backslash run before it so the native argv parser receives
 * the exact JSON text, including strings that themselves contain quotes or end in a backslash.
 *
 * Escaping the quotes is necessary but not sufficient. Once the value contains a `"`, PowerShell 5
 * hands the string to the native command *verbatim*, without wrapping it in quotes of its own — so
 * the MSVCRT argv parser splits the JSON on every space and Claude Code receives dozens of garbage
 * arguments instead of one agent definition (68 argv entries for the web-research agent, and the
 * agent silently never registered). Encoding each literal space as ` ` keeps the payload
 * whitespace-free, and since it is a JSON string escape the parsed object is byte-identical.
 */
const quotePowerShellNativeJsonArgument = (value: Readonly<Record<string, unknown>>): string => {
  const serialized = JSON.stringify(value);
  const nativeSafe = serialized
    .replace(/(\\*)"/g, (_match, backslashes: string) => `${backslashes}${backslashes}\\"`)
    .replaceAll(' ', '\\u0020');
  return quotePowerShellArgument(nativeSafe);
};

export interface ClaudeLaunchPermissions {
  /**
   * Adds `bypassPermissions` to the Shift+Tab cycle without starting in it. Claude Code refuses to
   * enter that mode mid-session unless the launch armed it, so this is the only way the status-bar
   * picker can ever reach 「完全允许」.
   */
  allowBypass: boolean;
  /** Mode to begin in. `dontAsk` never joins the cycle, so it can only arrive through here. */
  startMode?: ClaudePermissionMode;
}

export interface ClaudeLaunchExtensions {
  /** CLI-defined subagents exist only for this Claude Code process and never touch user settings. */
  agents?: Readonly<Record<string, unknown>>;
  /** Appended to Claude Code's default prompt; unlike `--agent`, this preserves native behavior. */
  appendSystemPrompt?: string;
}

export const buildClaudeLaunchCommand = (
  settingsPath: string,
  mode: ClaudeLaunchMode,
  exitMarker: string,
  resumeSessionId?: string,
  permissions?: ClaudeLaunchPermissions,
  extensions?: ClaudeLaunchExtensions,
): string => {
  const argumentsList = ['--settings', quotePowerShellArgument(settingsPath)];

  if (permissions?.startMode && permissions.startMode !== 'default') {
    argumentsList.push('--permission-mode', quotePowerShellArgument(permissions.startMode));
  }
  // The `--allow-` variant only widens the cycle; `bypassPermissions` still has to be chosen
  // explicitly, so arming it here does not change how the session behaves on its own.
  if (permissions?.allowBypass && permissions.startMode !== 'bypassPermissions') {
    argumentsList.push('--allow-dangerously-skip-permissions');
  }
  if (extensions?.agents && Object.keys(extensions.agents).length > 0) {
    argumentsList.push('--agents', quotePowerShellNativeJsonArgument(extensions.agents));
  }
  if (extensions?.appendSystemPrompt) {
    argumentsList.push(
      '--append-system-prompt',
      quotePowerShellArgument(extensions.appendSystemPrompt),
    );
  }

  if (mode === 'continue') {
    argumentsList.push('--continue');
  } else if (mode === 'resume') {
    argumentsList.push('--resume');
    if (resumeSessionId) {
      argumentsList.push(quotePowerShellArgument(resumeSessionId));
    }
  }

  const cleanupPaths = [
    ...MANAGED_CLAUDE_ENVIRONMENT_KEYS,
    'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_AUTOUPDATER',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_FEEDBACK_COMMAND',
    'DISABLE_TELEMETRY',
    'DO_NOT_TRACK',
  ]
    .map((key) => `Env:${key}`)
    .join(',');
  const encodedMarker = Buffer.from(exitMarker, 'utf8').toString('base64');

  return [
    `& claude ${argumentsList.join(' ')}`,
    `Remove-Item ${cleanupPaths} -ErrorAction SilentlyContinue`,
    `[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMarker}')))`,
  ].join('; ');
};

export const buildStatusLineCommand = (scriptPath: string, outputPath: string): string => {
  const normalizedScriptPath = path.resolve(scriptPath).replaceAll('\\', '/');
  const normalizedOutputPath = path.resolve(outputPath).replaceAll('\\', '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${normalizedScriptPath}" -OutputPath "${normalizedOutputPath}"`;
};

export const buildRuntimeSignalCommand = (
  scriptPath: string,
  outputPath: string,
  event: string,
): string => {
  const normalizedScriptPath = path.resolve(scriptPath).replaceAll('\\', '/');
  const normalizedOutputPath = path.resolve(outputPath).replaceAll('\\', '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${normalizedScriptPath}" -OutputPath "${normalizedOutputPath}" -Event "${event}"`;
};

export const buildRuntimeActivityCommand = (
  scriptPath: string,
  outputDirectory: string,
  event: string,
  sessionId: string,
  launchGeneration: number,
  ptyGeneration: number,
): string => {
  const normalizedScriptPath = path.resolve(scriptPath).replaceAll('\\', '/');
  const normalizedOutputDirectory = path.resolve(outputDirectory).replaceAll('\\', '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${normalizedScriptPath}" -OutputDirectory "${normalizedOutputDirectory}" -Event "${event}" -SessionId "${sessionId}" -LaunchGeneration ${launchGeneration} -PtyGeneration ${ptyGeneration}`;
};

export const buildClaudePermissionHookCommand = (
  scriptPath: string,
  pipeName: string,
  token: string,
  sessionId: string,
  launchGeneration: number,
): string => {
  const normalizedScriptPath = path.resolve(scriptPath).replaceAll('\\', '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${normalizedScriptPath}" -PipeName "${pipeName}" -Token "${token}" -SessionId "${sessionId}" -LaunchGeneration ${launchGeneration}`;
};

export const buildWebSearchGuardCommand = (scriptPath: string, allowedAgent: string): string => {
  const normalizedScriptPath = path.resolve(scriptPath).replaceAll('\\', '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${normalizedScriptPath}" -AllowedAgent "${allowedAgent}"`;
};
