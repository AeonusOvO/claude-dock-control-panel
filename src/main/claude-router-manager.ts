import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ClaudeRouterGatewayState,
  ClaudeRouterInstallSource,
  ClaudeRouterManagementState,
  ClaudeRouterProviderProtocol,
  ClaudeRouterProviderView,
  RouterOperationKind,
  RouterOperationProgress,
  SaveClaudeRouterProviderInput,
} from '../shared/contracts';
import { completeConnectionEndpoint } from '../shared/connection-endpoint';
import { runWindowsCommand } from './windows-command';

const execFileAsync = promisify(execFile);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const PROVIDER_PROTOCOLS = new Set<ClaudeRouterProviderProtocol>([
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
]);
const PROVIDER_PROTOCOL_VALUES = new Set([
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
]);
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const SERVICE_WAIT_MS = 20_000;

interface CcrCliInstallation {
  cliPath: string;
  installDirectory: string;
  nodeExecutable?: string;
  packageRoot: string;
  version: string;
}

interface CcrServiceAccess {
  managementUrl: string;
  origin: string;
  pid: number;
  serviceToken: string;
  webToken: string;
}

interface CcrGatewayStatus {
  endpoint?: unknown;
  lastError?: unknown;
  state?: unknown;
}

interface CcrAppInfo {
  version?: unknown;
}

interface CcrProviderConfig extends Record<string, unknown> {
  id?: unknown;
  models?: unknown;
  name?: unknown;
}

interface CcrAppConfig extends Record<string, unknown> {
  APIKEY?: unknown;
  APIKEYS?: unknown;
  Providers?: unknown;
  preferredProvider?: unknown;
}

interface CcrRpcSuccess<T> {
  ok: true;
  value: T;
}

interface CcrRpcFailure {
  error?: { message?: unknown };
  ok: false;
}

export interface SavedRouterProvider {
  connection: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  provider: ClaudeRouterProviderView;
  state: ClaudeRouterManagementState;
}

export interface RouterPackageOperation {
  message: string;
  state: ClaudeRouterManagementState;
}

interface RouterOperationJournal {
  operation: 'install';
  phase: RouterOperationProgress['stage'];
  schemaVersion: 1;
  source: ClaudeRouterInstallSource;
  startedAt: number;
  updatedAt: number;
}

interface NormalizedRouterProviderInput extends Omit<
  SaveClaudeRouterProviderInput,
  'apiKey' | 'baseUrl' | 'id' | 'models' | 'name'
> {
  apiKey?: string;
  baseUrl: string;
  id?: string;
  models: string[];
  name: string;
}

interface UpdatedRouterConfig {
  config: CcrAppConfig;
  providerId: string;
}

const appDataRoot = (): string =>
  process.env.APPDATA ?? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Roaming');

const localAppDataRoot = (): string =>
  process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');

/** CCR shared files that CLI uninstall may remove only when no desktop installation exists. */
export const ROUTER_DATA_ENTRIES = [
  'config.sqlite',
  'api-keys.sqlite',
  'usage.sqlite',
  'gateway.config.json',
  'service.json',
  'gateway-proxy-preload.cjs',
  'claude-app-gateway-backup.json',
  'global-profile-takeover.json',
  'bin',
  'provider-icons',
  'raw-trace-spool',
] as const;

/**
 * A recursive delete only ever runs against the CCR data directory itself. Anything that does not
 * resolve to `<AppData>\claude-code-router` is refused so a tampered `APPDATA` cannot widen the
 * blast radius, and so Claude Code's and Codex's own configuration can never be reached.
 */
export const routerDataDirectory = (appData: string): string | undefined => {
  if (!appData || !path.isAbsolute(appData)) {
    return undefined;
  }
  const resolved = path.resolve(appData, 'claude-code-router');
  const parent = path.dirname(resolved);
  if (
    path.basename(resolved).toLowerCase() !== 'claude-code-router' ||
    parent === resolved ||
    path.resolve(parent) !== path.resolve(appData)
  ) {
    return undefined;
  }
  return resolved;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const safeMessage = (error: unknown, secrets: string[] = []): string => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, '[已隐藏]');
    }
  }
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(/ccr_web_token=[A-Za-z0-9_-]+/gi, 'ccr_web_token=[已隐藏]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
};

const routerNativeModuleMismatch = (
  error: unknown,
): { compiledAbi?: string; requiredAbi?: string } | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !/compiled against a different Node\.js version|NODE_MODULE_VERSION/i.test(message) ||
    !/better[-_]?sqlite3|better_sqlite3/i.test(message)
  ) {
    return undefined;
  }
  const match =
    /NODE_MODULE_VERSION\s+(\d+)[\s\S]{0,400}?requires\s+NODE_MODULE_VERSION\s+(\d+)/i.exec(
      message,
    );
  return {
    compiledAbi: match?.[1],
    requiredAbi: match?.[2],
  };
};

export const routerNativeModuleErrorMessage = (error: unknown): string | undefined => {
  const mismatch = routerNativeModuleMismatch(error);
  if (!mismatch) {
    return undefined;
  }
  const abiDetail =
    mismatch.compiledAbi && mismatch.requiredAbi
      ? `（原生模块 ABI ${mismatch.compiledAbi}，当前运行时 ABI ${mismatch.requiredAbi}）`
      : '';
  return `路由器的 Node.js 运行环境不匹配${abiDetail}。点击“修复运行环境并重启”，ClaudeDock 会改用 CCR 安装时配套的系统 Node.js；不会重编译数据库，也不会修改服务提供方或 Codex。`;
};

export const routerServiceRunsInAppRuntime = (
  serviceImageName: string,
  appExecutable: string,
): boolean => {
  const serviceImage = path.basename(serviceImageName).toLowerCase();
  const appImage = path.basename(appExecutable).toLowerCase();
  return (
    Boolean(serviceImage) &&
    Boolean(appImage) &&
    appImage !== 'node.exe' &&
    serviceImage === appImage
  );
};

export const tasklistImageNames = (bytes: Uint8Array): string[] => {
  const imageNames = new Set<string>();
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      const output = new TextDecoder(encoding).decode(bytes).trim();
      const imageMatch = /^"((?:""|[^"])*)"/.exec(output);
      const imageName = imageMatch?.[1]?.replaceAll('""', '"').trim();
      if (imageName) {
        imageNames.add(imageName);
      }
    } catch {
      // Try the other Windows console encoding.
    }
  }
  return [...imageNames];
};

export const routerCliStartSpec = (
  nodeExecutable: string,
  cliPath: string,
): { args: string[]; executable: string } => ({
  args: [cliPath, 'start', '--no-open', '--gateway'],
  executable: nodeExecutable,
});

export const routerGatewayErrorMessage = (providerCount: number, lastError?: string): string => {
  if (
    providerCount === 0 ||
    /No available models|Configure at least one provider/i.test(lastError ?? '')
  ) {
    return '路由器管理服务已运行，但 3456 模型网关无法启动：还没有配置服务提供方和模型。请按下方“解决办法”添加第一个服务提供方。';
  }
  const detail = lastError
    ? '网关返回了错误；原始信息已保留在终端输出或日志中。'
    : '请检查服务提供方的地址、模型和密钥。';
  return `路由器管理服务已运行，但 3456 模型网关出错：${detail} 请编辑服务提供方后重新启动。`;
};

const readJsonFile = (filePath: string, maximumBytes = 2 * 1024 * 1024): unknown => {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
    throw new Error('CCR 状态文件大小异常。');
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
};

const normalizeProviderBaseUrl = (value: string, protocol: ClaudeRouterProviderProtocol): string =>
  completeConnectionEndpoint(value, protocol === 'anthropic_messages' ? 'anthropic' : 'openai');

export const normalizeRouterProviderInput = (
  input: SaveClaudeRouterProviderInput,
): NormalizedRouterProviderInput => {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) {
    throw new Error('服务提供方名称只能包含字母、数字、点、下划线和短横线。');
  }
  if (input.id !== undefined && (input.id.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(input.id))) {
    throw new Error('服务提供方标识无效。');
  }
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) {
    throw new Error('服务提供方协议不受支持。');
  }
  const models = [
    ...new Set(input.models.map((model) => model.trim()).filter((model) => Boolean(model))),
  ];
  if (
    models.length === 0 ||
    models.length > 50 ||
    models.some((model) => !/^[-A-Za-z0-9._:/@[\]]{1,200}$/.test(model))
  ) {
    throw new Error('模型标识只能包含字母、数字以及 . _ : / @ [ ] -。');
  }
  const apiKey = input.apiKey?.trim();
  if (input.credentialAction === 'replace' && !apiKey) {
    throw new Error('新增或替换服务提供方时必须填写上游接口密钥。');
  }
  if (apiKey && (apiKey.length > 20_000 || /[\r\n]/.test(apiKey))) {
    throw new Error('上游接口密钥格式无效。');
  }
  return {
    apiKey,
    baseUrl: normalizeProviderBaseUrl(input.baseUrl, input.protocol),
    credentialAction: input.credentialAction,
    id: input.id,
    makePreferred: Boolean(input.makePreferred),
    models,
    name,
    protocol: input.protocol,
    useForCurrentProject: Boolean(input.useForCurrentProject),
  };
};

const providerBaseUrl = (provider: Record<string, unknown>): string =>
  optionalString(provider.api_base_url) ??
  optionalString(provider.baseUrl) ??
  optionalString(provider.baseurl) ??
  '';

const providerProtocol = (provider: Record<string, unknown>): ClaudeRouterProviderProtocol => {
  const type = optionalString(provider.type);
  return type && PROVIDER_PROTOCOL_VALUES.has(type)
    ? (type as ClaudeRouterProviderProtocol)
    : 'openai_chat_completions';
};

const providerHasCredential = (provider: Record<string, unknown>): boolean => {
  if (
    optionalString(provider.api_key) ||
    optionalString(provider.apiKey) ||
    optionalString(provider.apikey)
  ) {
    return true;
  }
  return (
    Array.isArray(provider.credentials) &&
    provider.credentials.some(
      (credential) =>
        isRecord(credential) &&
        Boolean(
          optionalString(credential.api_key) ??
          optionalString(credential.apiKey) ??
          optionalString(credential.apikey),
        ),
    )
  );
};

const providerModels = (provider: Record<string, unknown>): string[] =>
  Array.isArray(provider.models)
    ? provider.models
        .filter((model): model is string => typeof model === 'string')
        .map((model) => model.trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];

const providerView = (
  provider: Record<string, unknown>,
  index: number,
  preferredProvider: string,
): ClaudeRouterProviderView => {
  const name = optionalString(provider.name) ?? `服务提供方 ${index + 1}`;
  const id =
    optionalString(provider.id) ??
    name
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '') ??
    `provider-${index + 1}`;
  return {
    baseUrl: providerBaseUrl(provider),
    credentialConfigured: providerHasCredential(provider),
    id: id || `provider-${index + 1}`,
    models: providerModels(provider),
    name,
    preferred: preferredProvider === name || preferredProvider === id,
    protocol: providerProtocol(provider),
  };
};

const providerRecords = (config: CcrAppConfig): CcrProviderConfig[] =>
  Array.isArray(config.Providers)
    ? config.Providers.filter((provider): provider is CcrProviderConfig => isRecord(provider))
    : [];

export const sanitizeRouterConfig = (config: CcrAppConfig): ClaudeRouterProviderView[] => {
  const preferredProvider = optionalString(config.preferredProvider) ?? '';
  return providerRecords(config).map((provider, index) =>
    providerView(provider, index, preferredProvider),
  );
};

const providerSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'provider';

const uniqueProviderId = (providers: CcrProviderConfig[], name: string): string => {
  const base = providerSlug(name);
  const existing = new Set(
    providers.map((provider) => optionalString(provider.id)).filter(Boolean),
  );
  if (!existing.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
};

export const buildUpdatedRouterConfig = (
  source: CcrAppConfig,
  rawInput: SaveClaudeRouterProviderInput,
): UpdatedRouterConfig => {
  const input = normalizeRouterProviderInput(rawInput);
  const config = structuredClone(source);
  const providers = providerRecords(config);
  const existingIndex = input.id
    ? providers.findIndex((provider) => optionalString(provider.id) === input.id)
    : -1;
  if (input.id && existingIndex < 0) {
    throw new Error('要编辑的服务提供方已不存在，请重新检测。');
  }
  const duplicateIndex = providers.findIndex(
    (provider, index) => index !== existingIndex && optionalString(provider.name) === input.name,
  );
  if (duplicateIndex >= 0) {
    throw new Error('服务提供方名称已存在，请换一个名称。');
  }

  const previous = existingIndex >= 0 ? providers[existingIndex] : undefined;
  const providerId = optionalString(previous?.id) ?? uniqueProviderId(providers, input.name);
  const capabilities = Array.isArray(previous?.capabilities)
    ? previous.capabilities.filter(
        (capability) =>
          isRecord(capability) &&
          !PROVIDER_PROTOCOL_VALUES.has(optionalString(capability.type) ?? ''),
      )
    : [];
  const next: CcrProviderConfig = {
    ...(previous ?? {}),
    api_base_url: input.baseUrl,
    capabilities: [
      ...capabilities,
      {
        baseUrl: input.baseUrl,
        source: 'detected',
        type: input.protocol,
      },
    ],
    id: providerId,
    models: input.models,
    name: input.name,
    type: input.protocol,
  };
  delete next.baseUrl;
  delete next.baseurl;
  if (input.credentialAction === 'replace') {
    next.api_key = input.apiKey ?? '';
    delete next.apiKey;
    delete next.apikey;
  } else if (input.credentialAction === 'clear') {
    delete next.api_key;
    delete next.apiKey;
    delete next.apikey;
    delete next.credentials;
  }

  if (existingIndex >= 0) {
    providers[existingIndex] = next;
  } else {
    providers.push(next);
  }
  config.Providers = providers;
  if (
    input.makePreferred ||
    !optionalString(config.preferredProvider) ||
    (previous &&
      [optionalString(previous.name), optionalString(previous.id)].includes(
        optionalString(config.preferredProvider),
      ))
  ) {
    config.preferredProvider = input.name;
  }
  return { config, providerId };
};

export const buildDeletedRouterConfig = (
  source: CcrAppConfig,
  providerId: string,
): CcrAppConfig => {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(providerId)) {
    throw new Error('服务提供方标识无效。');
  }
  const config = structuredClone(source);
  const providers = providerRecords(config);
  const removed = providers.find((provider) => optionalString(provider.id) === providerId);
  if (!removed) {
    throw new Error('要删除的服务提供方已不存在。');
  }
  config.Providers = providers.filter((provider) => optionalString(provider.id) !== providerId);
  if (
    [optionalString(removed.name), optionalString(removed.id)].includes(
      optionalString(config.preferredProvider),
    )
  ) {
    config.preferredProvider = optionalString(providerRecords(config)[0]?.name) ?? '';
  }
  return config;
};

const readGatewayApiKey = (config: CcrAppConfig): string => {
  const direct = optionalString(config.APIKEY);
  if (direct) {
    return direct;
  }
  if (Array.isArray(config.APIKEYS)) {
    for (const candidate of config.APIKEYS) {
      if (isRecord(candidate)) {
        const key = optionalString(candidate.key);
        if (key) {
          return key;
        }
      }
    }
  }
  throw new Error('CCR 没有可用于本机网关的访问密钥。');
};

const versionMajor = (version: string | undefined): number | undefined => {
  const match = /^(\d+)\./.exec(version ?? '');
  return match ? Number(match[1]) : undefined;
};

export class ClaudeRouterManager {
  private installInFlight?: Promise<RouterPackageOperation>;
  private readonly operationJournalPath: string;
  private serviceRuntimeCache?: {
    kind: 'claudedock' | 'cli' | 'desktop' | 'unknown';
    pid: number;
  };

  public constructor(
    userDataPath: string,
    private readonly onOperationProgress: (progress: RouterOperationProgress) => void = () => {},
    private readonly commandEnvironment: () => Record<
      string,
      null | string | undefined
    > = () => ({}),
    private readonly runCommand: typeof runWindowsCommand = runWindowsCommand,
  ) {
    this.operationJournalPath = path.join(userDataPath, 'claude', 'router-operation.json');
  }

  private emitProgress(
    operation: RouterOperationKind,
    stage: RouterOperationProgress['stage'],
    step: number,
    totalSteps: number,
    detail: string,
    active = true,
  ): void {
    this.onOperationProgress({
      active,
      detail,
      operation,
      stage,
      step,
      totalSteps,
      updatedAt: Date.now(),
    });
  }

  private readOperationJournal(): RouterOperationJournal | undefined {
    if (!existsSync(this.operationJournalPath)) {
      return undefined;
    }
    try {
      const value = JSON.parse(readFileSync(this.operationJournalPath, 'utf8')) as unknown;
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.operation !== 'install' ||
        (value.source !== 'npm' && value.source !== 'npmmirror') ||
        typeof value.startedAt !== 'number' ||
        typeof value.updatedAt !== 'number' ||
        typeof value.phase !== 'string'
      ) {
        return undefined;
      }
      return value as unknown as RouterOperationJournal;
    } catch {
      return undefined;
    }
  }

  private writeOperationJournal(journal: RouterOperationJournal): void {
    mkdirSync(path.dirname(this.operationJournalPath), { recursive: true });
    const temporaryPath = `${this.operationJournalPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(journal, undefined, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.operationJournalPath);
  }

  private updateOperationJournal(phase: RouterOperationProgress['stage']): void {
    const current = this.readOperationJournal();
    if (!current) {
      return;
    }
    this.writeOperationJournal({ ...current, phase, updatedAt: Date.now() });
  }

  private updateOperationJournalSource(source: ClaudeRouterInstallSource): void {
    const current = this.readOperationJournal();
    if (current) {
      this.writeOperationJournal({ ...current, source, updatedAt: Date.now() });
    }
  }

  private clearOperationJournal(): void {
    for (const journalPath of [this.operationJournalPath, `${this.operationJournalPath}.tmp`]) {
      try {
        unlinkSync(journalPath);
      } catch {
        // It is safe for an already-cleared journal to be absent.
      }
    }
  }

  public async getState(): Promise<ClaudeRouterManagementState> {
    const checkedAt = Date.now();
    const [cli, desktop] = await Promise.all([
      this.findCliInstallation(),
      Promise.resolve(this.findDesktopExecutable()),
    ]);
    const access = await this.getActiveServiceAccess();
    const accessKind = access ? await this.serviceRuntimeKind(access, desktop) : undefined;
    const cliAccess = accessKind === 'cli' || accessKind === 'claudedock';
    const installationKind =
      cli && desktop ? 'mixed' : cli ? 'npm' : desktop ? 'desktop' : 'unknown';
    const installation = {
      // Desktop CCR and its shared data are never uninstall targets for ClaudeDock's CLI-only path.
      canUninstall: Boolean(cli),
      installationKind,
    } as const;
    if (!access || !cliAccess) {
      const installed = Boolean(cli);
      const cliManageable = Boolean(cli?.nodeExecutable && (versionMajor(cli.version) ?? 0) >= 3);
      const manageable = cliManageable;
      return {
        ...installation,
        checkedAt,
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'stopped',
        installed,
        manageable,
        managementAvailable: false,
        message:
          access && !cliAccess
            ? '检测到 CCR 桌面版服务正在运行；ClaudeDock 不会接管或改写桌面 App，请关闭该服务后再启用独立 CLI 路由。'
            : installed
              ? manageable
                ? 'Claude Code Router CLI 已安装，但后台服务当前未运行。'
                : cli && (versionMajor(cli.version) ?? 0) >= 3
                  ? '检测到 CCR CLI 3.x，但没有找到能加载其 better-sqlite3 的系统 Node.js；请安装或更新 Node.js。'
                  : '检测到旧版 CCR CLI；请在 ClaudeDock 中一键更新后继续。'
              : desktop
                ? '仅检测到 CCR 桌面版；ClaudeDock 不会操作它，可在后台另行安装 CLI 路由。'
                : '尚未检测到 Claude Code Router CLI，可由 ClaudeDock 在后台自动安装。',
        providers: [],
        serviceRunning: false,
        version: cli?.version,
      };
    }

    if (cli?.nodeExecutable && accessKind === 'claudedock') {
      return {
        ...installation,
        checkedAt,
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'unknown',
        installed: true,
        manageable: true,
        managementAvailable: false,
        message:
          '检测到 CCR 正由 ClaudeDock 的 Electron 内置 Node.js 运行，可能把服务提供方误报为空并触发原生模块兼容错误。点击“修复运行环境并重启”；数据库、服务提供方和 Codex 都不会被修改。',
        providers: [],
        runtimeMismatch: true,
        serviceRunning: true,
        version: cli.version,
      };
    }

    try {
      const [appInfo, gateway, config] = await Promise.all([
        this.rpcWithAccess<CcrAppInfo>(access, 'getAppInfo'),
        this.rpcWithAccess<CcrGatewayStatus>(access, 'getGatewayStatus'),
        this.rpcWithAccess<CcrAppConfig>(access, 'getConfig'),
      ]);
      const gatewayState = this.gatewayState(gateway.state);
      const gatewayStateText =
        gatewayState === 'starting'
          ? '启动中'
          : gatewayState === 'stopped'
            ? '已停止'
            : gatewayState === 'unknown'
              ? '未知'
              : gatewayState;
      const lastError = optionalString(gateway.lastError);
      const providers = sanitizeRouterConfig(config);
      return {
        ...installation,
        checkedAt,
        endpoint: optionalString(gateway.endpoint) ?? 'http://127.0.0.1:3456',
        gatewayState,
        installed: true,
        manageable: true,
        managementAvailable: true,
        message:
          gatewayState === 'running'
            ? `路由器网关正在运行，已配置 ${providers.length} 个服务提供方。`
            : gatewayState === 'error'
              ? routerGatewayErrorMessage(providers.length, lastError)
              : `路由器管理服务已运行，网关状态：${gatewayStateText}。`,
        providers,
        serviceRunning: true,
        version: optionalString(appInfo.version) ?? cli?.version,
      };
    } catch (error) {
      const nativeModuleMessage = routerNativeModuleErrorMessage(error);
      return {
        ...installation,
        checkedAt,
        endpoint: 'http://127.0.0.1:3456',
        gatewayState: 'unknown',
        installed: true,
        manageable: Boolean(nativeModuleMessage && cli?.nodeExecutable),
        managementAvailable: false,
        message:
          nativeModuleMessage ??
          'CCR 管理服务响应异常；请重启路由器，或查看终端输出和日志了解详情。',
        providers: [],
        runtimeMismatch: Boolean(nativeModuleMessage),
        serviceRunning: true,
        version: cli?.version,
      };
    }
  }

  public async installFromNpm(source: ClaudeRouterInstallSource): Promise<RouterPackageOperation> {
    return this.runInstallOnce(source, 'install');
  }

  /** Replays an interrupted npm install. npm's global install is idempotent, so no data is reset. */
  public async recoverInterruptedInstall(): Promise<RouterPackageOperation | undefined> {
    const journal = this.readOperationJournal();
    if (!journal) {
      // A torn or obsolete journal is not trustworthy. Clear it and let the next install start cleanly.
      if (existsSync(this.operationJournalPath) || existsSync(`${this.operationJournalPath}.tmp`)) {
        this.clearOperationJournal();
      }
      return undefined;
    }
    this.emitProgress(
      'recover',
      'recovering',
      1,
      5,
      '检测到上次安装意外中断，正在自动校验并续装。',
    );
    return this.runInstallOnce(journal.source, 'recover');
  }

  private runInstallOnce(
    source: ClaudeRouterInstallSource,
    operation: 'install' | 'recover',
  ): Promise<RouterPackageOperation> {
    if (this.installInFlight) {
      return this.installInFlight;
    }
    this.installInFlight = this.installFromNpmInternal(source, operation).finally(() => {
      this.installInFlight = undefined;
    });
    return this.installInFlight;
  }

  private async installFromNpmInternal(
    source: ClaudeRouterInstallSource,
    operation: 'install' | 'recover',
  ): Promise<RouterPackageOperation> {
    let effectiveSource = source;
    const registry =
      source === 'npmmirror' ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org';
    const commandEnvironment = this.commandEnvironment();
    const proxyNote =
      typeof commandEnvironment.HTTPS_PROXY === 'string' ||
      typeof commandEnvironment.https_proxy === 'string'
        ? '已使用 ClaudeDock 为 CLI 配置的应用代理。'
        : '将使用 npm 当前可用的网络环境。';
    const startedAt = this.readOperationJournal()?.startedAt ?? Date.now();
    try {
      this.writeOperationJournal({
        operation: 'install',
        phase: operation === 'recover' ? 'recovering' : 'checking',
        schemaVersion: 1,
        source,
        startedAt,
        updatedAt: Date.now(),
      });
      this.emitProgress(operation, 'checking', 1, 5, '正在检查 Node.js、npm 与现有 CCR CLI。');

      this.updateOperationJournal('downloading');
      this.emitProgress(
        operation,
        'downloading',
        2,
        5,
        source === 'npmmirror'
          ? `正在从 npmmirror 获取 CCR CLI；${proxyNote}`
          : `正在从 npm 官方源获取 CCR CLI；${proxyNote}`,
      );
      const installFromRegistry = (registryUrl: string): Promise<string> =>
        this.runCommand(
          'npm',
          [
            'install',
            '--global',
            '@musistudio/claude-code-router@latest',
            '--registry',
            registryUrl,
          ],
          {
            env: commandEnvironment,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 10 * 60_000,
          },
        );
      try {
        await installFromRegistry(registry);
      } catch (error) {
        if (source !== 'npm' || /未找到 npm 命令/.test(safeMessage(error))) {
          throw error;
        }
        effectiveSource = 'npmmirror';
        this.updateOperationJournalSource(effectiveSource);
        this.emitProgress(
          operation,
          'downloading',
          2,
          5,
          `npm 官方源未完成，正在自动改用 npmmirror 续传；${proxyNote}`,
        );
        await installFromRegistry('https://registry.npmmirror.com');
      }

      this.updateOperationJournal('installing');
      this.emitProgress(
        operation,
        'installing',
        3,
        5,
        'npm 已完成写入，正在定位 CLI 与配套 Node.js。',
      );
      const cli = await this.findCliInstallation();
      if (!cli) {
        throw new Error('npm 命令已结束，但没有找到 CCR CLI；可重新点击安装进行修复。');
      }

      this.updateOperationJournal('verifying');
      this.emitProgress(operation, 'verifying', 4, 5, '正在验证 CLI 版本和后台运行环境。');
      const state = await this.getState();
      if (!state.installed) {
        throw new Error('CCR CLI 安装校验未通过；已保留恢复记录供下次自动重试。');
      }
      this.clearOperationJournal();
      this.emitProgress(
        operation,
        'complete',
        5,
        5,
        operation === 'recover' ? '中断的安装已自动恢复并验证完成。' : 'CCR CLI 已安装并验证完成。',
        false,
      );
      return {
        message:
          operation === 'recover'
            ? '上次中断的 CCR CLI 安装已自动恢复。'
            : effectiveSource === 'npmmirror'
              ? '已通过 npmmirror 安装或更新 Claude Code Router CLI。'
              : '已通过 npm 官方源安装或更新 Claude Code Router CLI。',
        state,
      };
    } catch (error) {
      this.emitProgress(
        operation,
        'error',
        5,
        5,
        `安装未完成：${safeMessage(error)}。恢复记录已保留，可再次点击安装或重启后自动续装。`,
        false,
      );
      throw error;
    }
  }

  /** Removes only the CLI package. A detected desktop installation and its shared data are kept. */
  public async uninstall(): Promise<RouterPackageOperation> {
    const cli = await this.findCliInstallation();
    const desktop = this.findDesktopExecutable();
    const dataDirectory = routerDataDirectory(appDataRoot());
    const hadData = Boolean(dataDirectory && existsSync(dataDirectory));
    if (!cli) {
      return {
        message: desktop
          ? '仅检测到 CCR 桌面版；ClaudeDock 不会卸载或修改它。'
          : '当前没有检测到可卸载的 CCR CLI。',
        state: await this.getState(),
      };
    }

    const access = await this.getActiveServiceAccess();
    if (access) {
      await this.stopCliService(access, desktop);
    }

    const notes: string[] = [await this.removeCliInstallation(cli)];

    if (desktop) {
      notes.push('已保留桌面版 CCR 及其共享配置，未改写 Claude/Codex App');
    } else if (dataDirectory) {
      try {
        rmSync(dataDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
        if (hadData) {
          notes.push('已删除全部服务提供方配置、上游密钥与用量数据');
        }
      } catch {
        notes.push(`无法删除配置目录 ${dataDirectory}，请关闭正在使用它的程序后重试`);
      }
    }

    this.serviceRuntimeCache = undefined;

    return {
      message: notes.length > 0 ? `${notes.join('；')}。` : '没有需要移除的路由器组件。',
      state: await this.getState(),
    };
  }

  /**
   * `npm uninstall --global` only reaches the package when it lives under the active npm prefix.
   * A CCR installed against another prefix (for example `D:\ClaudeCode`) survives it, so the
   * package directory is verified afterwards and removed directly when it is still present.
   */
  private async removeCliInstallation(cli: CcrCliInstallation): Promise<string> {
    try {
      await runWindowsCommand('npm', ['uninstall', '--global', '@musistudio/claude-code-router'], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
      });
    } catch {
      // Fall through to the prefix-scoped attempt and the direct removal below.
    }

    if (existsSync(cli.packageRoot)) {
      try {
        await runWindowsCommand(
          'npm',
          [
            'uninstall',
            '--global',
            '--prefix',
            cli.installDirectory,
            '@musistudio/claude-code-router',
          ],
          { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 },
        );
      } catch {
        // The directory removal below is the last resort.
      }
    }

    if (existsSync(cli.packageRoot)) {
      rmSync(cli.packageRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
    }
    for (const shim of ['ccr', 'ccr.cmd', 'ccr.ps1']) {
      const shimPath = path.join(cli.installDirectory, shim);
      if (existsSync(shimPath)) {
        try {
          unlinkSync(shimPath);
        } catch {
          // A locked shim stops working once its package is gone; report success anyway.
        }
      }
    }

    return existsSync(cli.packageRoot)
      ? `无法完全删除 ${cli.packageRoot}，请手动移除该目录`
      : '已移除命令行版路由器';
  }

  public async start(): Promise<ClaudeRouterManagementState> {
    this.emitProgress('start', 'checking', 1, 3, '正在检查 CCR CLI 后台状态。');
    try {
      const state = await this.startInternal();
      const detail =
        state.gatewayState === 'running'
          ? 'CCR CLI 后台与模型网关已就绪。'
          : state.managementAvailable
            ? 'CCR CLI 管理后台已就绪；模型网关正在等待服务商配置。'
            : state.message;
      this.emitProgress('start', 'complete', 3, 3, detail, false);
      return state;
    } catch (error) {
      this.emitProgress('start', 'error', 3, 3, `启动失败：${safeMessage(error)}`, false);
      throw error;
    }
  }

  private async startInternal(): Promise<ClaudeRouterManagementState> {
    const cli = await this.findCliInstallation();
    const desktop = this.findDesktopExecutable();
    const existing = await this.getActiveServiceAccess();
    if (existing) {
      const runtimeKind = await this.serviceRuntimeKind(existing, desktop);
      if (cli?.nodeExecutable && runtimeKind === 'claudedock') {
        await this.restartCliService(cli, existing);
        return this.getState();
      }
      if (runtimeKind !== 'cli') {
        throw new Error(
          '检测到非 CLI 的 CCR 后台正在运行；为保护 Claude/Codex App，ClaudeDock 不会接管或终止它。',
        );
      }
      try {
        await this.rpcWithAccess(existing, 'startGateway');
      } catch (error) {
        if (!routerNativeModuleMismatch(error) || !cli?.nodeExecutable) {
          throw error;
        }
        await this.restartCliService(cli, existing);
      }
      return this.getState();
    }

    if (cli) {
      if ((versionMajor(cli.version) ?? 0) < 3) {
        throw new Error('一键管理要求 Claude Code 路由器 3.x，请先升级。');
      }
      await this.startCliService(cli);
      this.emitProgress('start', 'starting', 2, 3, 'CCR CLI 管理服务已启动，正在启动模型网关。');
    } else {
      throw new Error('未找到 Claude Code Router CLI，请先由 ClaudeDock 在后台安装。');
    }

    const access = await this.waitForActiveService();
    await this.rpcWithAccess(access, 'startGateway');
    return this.getState();
  }

  public async stop(): Promise<ClaudeRouterManagementState> {
    this.emitProgress('stop', 'stopping', 1, 2, '正在停止 ClaudeDock 管理的 CCR CLI 后台。');
    const access = await this.getActiveServiceAccess();
    if (!access) {
      const state = await this.getState();
      this.emitProgress('stop', 'complete', 2, 2, 'CCR CLI 后台已经停止。', false);
      return state;
    }
    try {
      await this.stopCliService(access, this.findDesktopExecutable());
      const state = await this.getState();
      this.emitProgress('stop', 'complete', 2, 2, 'CCR CLI 后台与网关已停止。', false);
      return state;
    } catch (error) {
      this.emitProgress('stop', 'error', 2, 2, `停止失败：${safeMessage(error)}`, false);
      throw error;
    }
  }

  public async managementUrl(): Promise<string> {
    const access = await this.getActiveServiceAccess();
    if (
      !access ||
      (await this.serviceRuntimeKind(access, this.findDesktopExecutable())) !== 'cli'
    ) {
      throw new Error('CCR CLI 后台没有运行，无法打开管理页。');
    }
    return access.managementUrl;
  }

  public async saveProvider(rawInput: SaveClaudeRouterProviderInput): Promise<SavedRouterProvider> {
    this.emitProgress('configure', 'configuring', 1, 2, '正在写入服务提供方与模型映射（仅 CLI）。');
    try {
      const result = await this.saveProviderInternal(rawInput);
      this.emitProgress('configure', 'complete', 2, 2, 'CLI 路由配置已保存并校验。', false);
      return result;
    } catch (error) {
      this.emitProgress('configure', 'error', 2, 2, `配置失败：${safeMessage(error)}`, false);
      throw error;
    }
  }

  private async saveProviderInternal(
    rawInput: SaveClaudeRouterProviderInput,
  ): Promise<SavedRouterProvider> {
    const input = normalizeRouterProviderInput(rawInput);
    const access = await this.requireActiveService();
    const current = await this.rpcWithAccess<CcrAppConfig>(access, 'getConfig');
    const updated = buildUpdatedRouterConfig(current, input);
    const saved = await this.saveConfigWithoutProfileTakeover(access, updated.config, [
      input.apiKey ?? '',
    ]);
    const state = await this.getState();
    const provider = state.providers.find((item) => item.id === updated.providerId);
    if (!provider) {
      throw new Error('CCR 已保存配置，但没有返回对应服务提供方。');
    }
    return {
      connection: {
        apiKey: readGatewayApiKey(saved),
        baseUrl: state.endpoint,
        model: `${provider.name}/${provider.models[0]}`,
      },
      provider,
      state,
    };
  }

  public async deleteProvider(providerId: string): Promise<ClaudeRouterManagementState> {
    const access = await this.requireActiveService();
    const current = await this.rpcWithAccess<CcrAppConfig>(access, 'getConfig');
    const updated = buildDeletedRouterConfig(current, providerId);
    await this.saveConfigWithoutProfileTakeover(access, updated);
    return this.getState();
  }

  private async findCliInstallation(): Promise<CcrCliInstallation | undefined> {
    const directories = new Set<string>();
    try {
      const result = await execFileAsync('where.exe', ['ccr'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      });
      for (const line of result.stdout.split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate && path.isAbsolute(candidate)) {
          directories.add(path.dirname(candidate));
        }
      }
    } catch {
      // Fall through to the standard npm location.
    }
    directories.add(path.join(appDataRoot(), 'npm'));

    for (const directory of directories) {
      const packageRoot = path.join(directory, 'node_modules', '@musistudio', 'claude-code-router');
      const packageFile = path.join(packageRoot, 'package.json');
      const cliPath = path.join(packageRoot, 'dist', 'main', 'cli.js');
      if (!existsSync(packageFile) || !existsSync(cliPath)) {
        continue;
      }
      try {
        const parsed = readJsonFile(packageFile) as Record<string, unknown>;
        const version = optionalString(parsed.version);
        if (version && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
          return {
            cliPath,
            installDirectory: directory,
            nodeExecutable: await this.findCompatibleNodeExecutable(directory, packageRoot),
            packageRoot,
            version,
          };
        }
      } catch {
        // Try the next installation candidate.
      }
    }
    return undefined;
  }

  private async findCompatibleNodeExecutable(
    installationDirectory: string,
    packageRoot: string,
  ): Promise<string | undefined> {
    const candidates = new Set<string>();
    const localNode = path.join(installationDirectory, 'node.exe');
    if (existsSync(localNode)) {
      candidates.add(localNode);
    }
    try {
      const result = await execFileAsync('where.exe', ['node'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      });
      for (const line of result.stdout.split(/\r?\n/)) {
        const candidate = line.trim();
        if (
          candidate &&
          path.isAbsolute(candidate) &&
          path.basename(candidate).toLowerCase() === 'node.exe' &&
          existsSync(candidate)
        ) {
          candidates.add(candidate);
        }
      }
    } catch {
      // A local Node next to the npm prefix may still be available.
    }
    if (
      path.basename(process.execPath).toLowerCase() === 'node.exe' &&
      existsSync(process.execPath)
    ) {
      candidates.add(process.execPath);
    }

    const nativeBinding = path.join(
      packageRoot,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );
    for (const candidate of candidates) {
      try {
        const args = existsSync(nativeBinding)
          ? [
              '-e',
              'require(process.argv[1]); process.stdout.write(process.versions.modules || "")',
              nativeBinding,
            ]
          : ['-e', 'process.stdout.write(process.versions.modules || "")'];
        await execFileAsync(candidate, args, {
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
          timeout: 5_000,
          windowsHide: true,
        });
        return candidate;
      } catch {
        // Try another installed Node runtime.
      }
    }
    return undefined;
  }

  private nodeEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    return environment;
  }

  private async serviceRuntimeKind(
    access: CcrServiceAccess,
    desktopExecutable?: string,
  ): Promise<'claudedock' | 'cli' | 'desktop' | 'unknown'> {
    if (this.serviceRuntimeCache?.pid === access.pid) {
      return this.serviceRuntimeCache.kind;
    }
    let kind: 'claudedock' | 'cli' | 'desktop' | 'unknown' = 'unknown';
    try {
      const result = await execFileAsync(
        'tasklist.exe',
        ['/FI', `PID eq ${access.pid}`, '/FO', 'CSV', '/NH'],
        {
          encoding: 'buffer',
          maxBuffer: 64 * 1024,
          timeout: 3_000,
          windowsHide: true,
        },
      );
      const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
      const images = tasklistImageNames(bytes).map((imageName) =>
        path.basename(imageName).toLowerCase(),
      );
      const appImage = path.basename(process.execPath).toLowerCase();
      const desktopImage = desktopExecutable
        ? path.basename(desktopExecutable).toLowerCase()
        : undefined;
      if (images.includes('node.exe')) {
        kind = 'cli';
      } else if (appImage !== 'node.exe' && images.includes(appImage)) {
        kind = 'claudedock';
      } else if (desktopImage && images.includes(desktopImage)) {
        kind = 'desktop';
      }
    } catch {
      kind = 'unknown';
    }
    this.serviceRuntimeCache = { kind, pid: access.pid };
    return kind;
  }

  private async stopCliService(
    access: CcrServiceAccess,
    desktopExecutable?: string,
  ): Promise<void> {
    const runtimeKind = await this.serviceRuntimeKind(access, desktopExecutable);
    if (runtimeKind !== 'cli' && runtimeKind !== 'claudedock') {
      throw new Error(
        '检测到的 CCR 后台不是 ClaudeDock 管理的 CLI 进程；为保护 Claude/Codex App，已拒绝终止。',
      );
    }
    if (access.pid === process.pid) {
      throw new Error('拒绝终止 ClaudeDock 主进程；请完全退出旧版本后重试。');
    }
    try {
      await this.rpcWithAccess(access, 'stopGateway');
    } catch {
      // The service process can still be terminated when the gateway RPC is unavailable.
    }
    try {
      process.kill(access.pid, 'SIGTERM');
    } catch (error) {
      if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EINVAL')) {
        throw error;
      }
    }
    const stoppedAt = Date.now();
    while (Date.now() - stoppedAt < 10_000 && this.processIsRunning(access.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.processIsRunning(access.pid)) {
      throw new Error('CCR CLI 后台没有在 10 秒内退出，请完全退出相关 CLI 进程后重试。');
    }
    this.serviceRuntimeCache = undefined;
  }

  private async startCliService(cli: CcrCliInstallation): Promise<void> {
    if (!cli.nodeExecutable) {
      throw new Error(
        'CCR 已安装，但没有找到能加载 better-sqlite3 的系统 Node.js；请安装或更新官方版路由器。',
      );
    }
    const command = routerCliStartSpec(cli.nodeExecutable, cli.cliPath);
    await execFileAsync(command.executable, command.args, {
      encoding: 'utf8',
      env: this.nodeEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
  }

  private async restartCliService(
    cli: CcrCliInstallation,
    access: CcrServiceAccess,
  ): Promise<void> {
    if (!cli.nodeExecutable) {
      throw new Error('没有找到与 CCR 原生模块兼容的系统 Node.js。');
    }
    if (access.pid === process.pid) {
      throw new Error('拒绝终止 ClaudeDock 主进程；请彻底退出旧版后重新打开。');
    }
    try {
      process.kill(access.pid, 'SIGTERM');
    } catch (error) {
      if (!isRecord(error) || (error.code !== 'ESRCH' && error.code !== 'EINVAL')) {
        throw error;
      }
    }
    const stoppedAt = Date.now();
    while (Date.now() - stoppedAt < 10_000 && this.processIsRunning(access.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.processIsRunning(access.pid)) {
      throw new Error('旧 CCR 服务没有在 10 秒内退出，请彻底退出旧版 ClaudeDock 后重试。');
    }
    this.serviceRuntimeCache = undefined;
    await this.startCliService(cli);
    await this.waitForActiveService();
  }

  private processIsRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isRecord(error) && error.code === 'EPERM';
    }
  }

  private findDesktopExecutable(): string | undefined {
    const root = localAppDataRoot();
    const candidates = [
      path.join(root, 'Programs', 'claude-code-router', 'Claude Code Router.exe'),
      path.join(root, 'Programs', 'Claude Code Router', 'Claude Code Router.exe'),
      path.join(root, 'Claude Code Router', 'Claude Code Router.exe'),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  private serviceFile(): string {
    return path.join(appDataRoot(), 'claude-code-router', 'service.json');
  }

  private readServiceAccess(): CcrServiceAccess {
    const parsed = readJsonFile(this.serviceFile());
    if (!isRecord(parsed)) {
      throw new Error('CCR service.json 格式无效。');
    }
    const urlText = optionalString(parsed.url);
    const serviceToken = optionalString(parsed.serviceToken);
    const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    if (!urlText || !serviceToken || !Number.isInteger(pid) || pid <= 0) {
      throw new Error('CCR service.json 缺少必要字段。');
    }
    const url = new URL(urlText);
    if (
      url.protocol !== 'http:' ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password
    ) {
      throw new Error('CCR 管理服务不是受支持的本机地址。');
    }
    const webToken = url.searchParams.get('ccr_web_token')?.trim() ?? '';
    if (webToken.length < 20 || webToken.length > 300 || serviceToken.length > 300) {
      throw new Error('CCR 管理令牌格式无效。');
    }
    const origin = url.origin;
    return {
      managementUrl: url.toString(),
      origin,
      pid,
      serviceToken,
      webToken,
    };
  }

  private async getActiveServiceAccess(): Promise<CcrServiceAccess | undefined> {
    if (!existsSync(this.serviceFile())) {
      return undefined;
    }
    try {
      const access = this.readServiceAccess();
      const identity = await this.rpcWithAccess<Record<string, unknown>>(
        access,
        'getServiceIdentity',
        [access.serviceToken],
        [access.serviceToken, access.webToken],
      );
      if (identity.serviceTokenMatches !== true || identity.pid !== access.pid) {
        return undefined;
      }
      return access;
    } catch {
      return undefined;
    }
  }

  private async requireActiveService(): Promise<CcrServiceAccess> {
    const access = await this.getActiveServiceAccess();
    if (!access) {
      throw new Error('CCR 管理服务没有运行，请先点击“启动路由器”。');
    }
    return access;
  }

  private async waitForActiveService(): Promise<CcrServiceAccess> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SERVICE_WAIT_MS) {
      const access = await this.getActiveServiceAccess();
      if (access) {
        return access;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('等待 CCR 管理服务启动超时。');
  }

  /**
   * The only allowed CCR saveConfig call. ClaudeDock manages CLI routing only, so profile takeover
   * is forced off here instead of relying on every caller to remember a security-sensitive flag.
   */
  private saveConfigWithoutProfileTakeover(
    access: CcrServiceAccess,
    config: CcrAppConfig,
    secrets: string[] = [],
  ): Promise<CcrAppConfig> {
    return this.rpcWithAccess<CcrAppConfig>(
      access,
      'saveConfig',
      [config, { applyProfile: false }],
      secrets,
    );
  }

  private async rpcWithAccess<T>(
    access: CcrServiceAccess,
    method: string,
    args: unknown[] = [],
    secrets: string[] = [],
  ): Promise<T> {
    const response = await fetch(`${access.origin}/api/ccr/rpc`, {
      body: JSON.stringify({ args, method }),
      headers: {
        'content-type': 'application/json',
        'x-ccr-web-auth': access.webToken,
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RPC_RESPONSE_BYTES) {
      throw new Error('CCR 管理响应超过允许大小。');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RPC_RESPONSE_BYTES) {
      throw new Error('CCR 管理响应超过允许大小。');
    }
    let payload: CcrRpcSuccess<T> | CcrRpcFailure;
    try {
      payload = JSON.parse(bytes.toString('utf8')) as CcrRpcSuccess<T> | CcrRpcFailure;
    } catch {
      throw new Error(`CCR 管理接口返回了无效 JSON（HTTP ${response.status}）。`);
    }
    if (!response.ok || payload.ok !== true) {
      const message =
        payload.ok === false && typeof payload.error?.message === 'string'
          ? payload.error.message
          : `CCR 管理接口返回 HTTP ${response.status}。`;
      throw new Error(safeMessage(message, [access.webToken, access.serviceToken, ...secrets]));
    }
    return payload.value;
  }

  private gatewayState(value: unknown): ClaudeRouterGatewayState {
    return value === 'error' || value === 'running' || value === 'starting' || value === 'stopped'
      ? value
      : 'unknown';
  }
}
