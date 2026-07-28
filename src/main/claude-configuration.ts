import path from 'node:path';
import type {
  ClaudeInstallationStatus,
  ClaudeLaunchMode,
  ClaudePermissionMode,
  SaveClaudeConfigInput,
} from '../shared/contracts';
import { findClaudeProvider, providerForPreset } from '../shared/claude-providers';

export interface NormalizedClaudeConfig {
  authMode: SaveClaudeConfigInput['authMode'];
  baseUrl: string;
  model: string;
  modelFast?: string;
  preset: SaveClaudeConfigInput['preset'];
  provider: SaveClaudeConfigInput['provider'];
}

export type ClaudeEnvironmentOverrides = Record<string, null | string>;

export const DEFAULT_CLAUDE_CONFIG: NormalizedClaudeConfig = {
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
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  ...CLAUDE_ROUTE_ALIAS_ENVIRONMENT_KEYS,
] as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
export const MODEL_NAME_PATTERN = /^[-A-Za-z0-9._:/@[\]~]{1,200}$/;
const TRACKING_VERSION_START = [2, 1, 91] as const;
const TRACKING_VERSION_END = [2, 1, 196] as const;
const MINIMUM_PROTECTED_VERSION = [2, 1, 197] as const;

const compareVersions = (left: readonly number[], right: readonly number[]): -1 | 0 | 1 => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference < 0) {
      return -1;
    }
    if (difference > 0) {
      return 1;
    }
  }
  return 0;
};

export const parseClaudeVersion = (output: string): [number, number, number] | undefined => {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output);
  if (!match) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const evaluateClaudeInstallation = (
  output: string,
  executable?: string,
): ClaudeInstallationStatus => {
  const version = parseClaudeVersion(output);
  if (!version) {
    return {
      executable,
      installed: true,
      message: '已找到 Claude Code，但无法识别版本；受保护启动已停用。',
      security: 'unknown',
    };
  }

  const versionText = version.join('.');
  const isKnownTrackingVersion =
    compareVersions(version, TRACKING_VERSION_START) >= 0 &&
    compareVersions(version, TRACKING_VERSION_END) <= 0;

  if (isKnownTrackingVersion) {
    return {
      executable,
      installed: true,
      message: `版本 ${versionText} 位于已披露的隐藏地区/代理检测影响范围内，请先升级。`,
      security: 'blocked-version',
      version: versionText,
    };
  }

  if (compareVersions(version, MINIMUM_PROTECTED_VERSION) < 0) {
    return {
      executable,
      installed: true,
      message: `版本 ${versionText} 过旧；受保护启动要求 2.1.197 或更高版本。`,
      security: 'update-required',
      version: versionText,
    };
  }

  return {
    executable,
    installed: true,
    message: `Claude Code ${versionText} 已通过已知风险版本检查。`,
    security: 'ready',
    version: versionText,
  };
};

const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('接口地址不是有效网址。');
  }

  if (parsed.username || parsed.password) {
    throw new Error('接口地址不能内嵌用户名或密码。');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('接口地址不能包含查询参数或片段。');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()))
  ) {
    throw new Error('中转地址必须使用 HTTPS；仅本机回环地址允许 HTTP。');
  }
  if (/\/(?:v1\/)?chat\/completions\/?$/i.test(parsed.pathname)) {
    throw new Error(
      '这是 OpenAI /chat/completions 地址，不能直接用于 Claude Code；请先选用本地转换器。',
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/v1\/messages\/?$/i, '') || '/';

  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

export const normalizeClaudeConfig = (input: SaveClaudeConfigInput): NormalizedClaudeConfig => {
  const model = input.model.trim();
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new Error('模型标识只能包含字母、数字以及 . _ : / @ [ ] ~ -。');
  }
  const modelFast = input.modelFast?.trim() || model;
  if (!MODEL_NAME_PATTERN.test(modelFast)) {
    throw new Error('快速模型标识只能包含字母、数字以及 . _ : / @ [ ] ~ -。');
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

  return {
    authMode: input.authMode,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    model,
    modelFast,
    preset,
    provider: 'gateway',
  };
};

export const buildClaudeEnvironment = (
  config: NormalizedClaudeConfig,
  credential?: string,
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

  return environment;
};

export const buildClaudeSettingsEnvironment = (
  config: NormalizedClaudeConfig,
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

  return environment;
};

const quotePowerShellArgument = (value: string): string => `'${value.replaceAll("'", "''")}'`;

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

export const buildClaudeLaunchCommand = (
  settingsPath: string,
  model: string,
  mode: ClaudeLaunchMode,
  exitMarker: string,
  resumeSessionId?: string,
  permissions?: ClaudeLaunchPermissions,
): string => {
  const argumentsList = [
    '--settings',
    quotePowerShellArgument(settingsPath),
    '--model',
    quotePowerShellArgument(model),
    '--no-chrome',
  ];

  if (permissions?.startMode && permissions.startMode !== 'default') {
    argumentsList.push('--permission-mode', quotePowerShellArgument(permissions.startMode));
  }
  // The `--allow-` variant only widens the cycle; `bypassPermissions` still has to be chosen
  // explicitly, so arming it here does not change how the session behaves on its own.
  if (permissions?.allowBypass && permissions.startMode !== 'bypassPermissions') {
    argumentsList.push('--allow-dangerously-skip-permissions');
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
