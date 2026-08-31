import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  McpCatalog,
  McpCatalogEntry,
  McpBackupView,
  McpInstallInput,
  McpRemoveInput,
  McpServerView,
  McpTogglePreview,
  McpTransport,
} from '../../shared/contracts';
import { CURATED_MCP_SERVERS } from '../../shared/ui/mcp-catalog';
import type { BusyRegistry } from '../coordination/busy-registry';
import { RollbackCoordinator } from '../coordination/rollback';
import { AsyncRefreshCache } from '../infra/async-refresh-cache';
import { runWindowsCommand } from '../infra/windows-command';
import type { McpRegistrySyncService } from './registry-service';
import type { McpRegistryInputFields, McpRegistryRecord, McpRegistryState } from './registry-types';

const BACKUP_ID =
  /^(?:[0-9TZ-]+|[0-9TZ-]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const CATALOG_CACHE_TTL_MS = 10_000;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_TOGGLE_METADATA_BYTES = 256 * 1024;
const MAX_PENDING_TOGGLES = 32;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REGISTRY_REVALIDATE_INTERVAL_MS = 5 * 60_000;
const TOGGLE_PREVIEW_TTL_MS = 5 * 60_000;

interface DiscoveredServerInput {
  client: McpServerView['client'];
  config: Record<string, unknown>;
  configPath: string;
  enabled: boolean;
  healthDetail: string;
  name: string;
  scope: McpServerView['scope'];
  toggleSupported: boolean;
}

interface PendingToggle {
  beforeDigest: string;
  cwd: string;
  expiresAt: number;
  projectMcpDigest: string;
  projectMcpServerDigest: string;
  preview: McpTogglePreview;
  retainedBytes: number;
}

export interface McpManagerOptions {
  catalogCacheTtlMs?: number;
  now?: () => number;
  registryRevalidateIntervalMs?: number;
}

interface CuratedMcpInstallSpec {
  config: Record<string, unknown>;
  name: string;
}

interface ProjectMcpServerSnapshot {
  bytes: Buffer;
  digest: string;
  path: string;
  serverDigest: string;
  serverNames: ReadonlySet<string>;
  server: Record<string, unknown>;
}

/*
 * This allowlist is the complete direct-install authority. Registry metadata is browse-only and
 * renderer input can select only one of these IDs; it can never contribute command, args, URL,
 * environment, configuration, credentials, or package-manager confirmation flags.
 */
const CURATED_MCP_INSTALL_SPECS = new Map<string, CuratedMcpInstallSpec>([
  [
    'curated:filesystem',
    {
      config: {
        args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.10', '{{cwd}}'],
        command: 'npx',
        type: 'stdio',
      },
      name: 'filesystem',
    },
  ],
  [
    'curated:sequential-thinking',
    {
      config: {
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.7.4'],
        command: 'npx',
        type: 'stdio',
      },
      name: 'sequential-thinking',
    },
  ],
  [
    'curated:context7',
    {
      config: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      name: 'context7',
    },
  ],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const nonnegativeSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer.`);
  }
  return value;
};

const isNodeError = (error: unknown, code: string): boolean =>
  isRecord(error) && error.code === code;

const readBounded = (filePath: string, rejectSymbolicLink = false): Buffer => {
  let handle: number | undefined;
  try {
    if (rejectSymbolicLink && lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`MCP 配置文件不能是符号链接：${filePath}`);
    }
    handle = openSync(filePath, 'r');
    const stats = fstatSync(handle);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
      throw new Error(`MCP 配置文件大小异常：${filePath}`);
    }

    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_BYTES - offset));
      const count = readSync(handle, chunk, 0, chunk.length, offset);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      offset += count;
    }
    if (offset === MAX_CONFIG_BYTES) {
      const extra = Buffer.allocUnsafe(1);
      if (readSync(handle, extra, 0, 1, offset) > 0) {
        throw new Error(`MCP 配置文件大小异常：${filePath}`);
      }
    }
    return Buffer.concat(chunks, offset);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
};

const decodeJson = (bytes: Buffer, filePath: string): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`MCP 配置文件格式无效：${filePath}`, { cause: error });
  }
};

const readJsonRecord = (filePath: string, rejectSymbolicLink = false): Record<string, unknown> => {
  try {
    const value = decodeJson(readBounded(filePath, rejectSymbolicLink), filePath);
    return isRecord(value) ? value : {};
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return {};
    throw error;
  }
};

const tryReadJsonRecord = (filePath: string): Record<string, unknown> => {
  try {
    return readJsonRecord(filePath);
  } catch {
    // A malformed, inaccessible, or oversized source is independent of the other MCP sources.
    return {};
  }
};

const serverTransport = (config: Record<string, unknown>): McpTransport => {
  const type = optionalString(config.type)?.toLowerCase();
  if (type === 'sse') {
    return 'sse';
  }
  if (type === 'http' || type === 'streamable-http' || optionalString(config.url)) {
    return 'http';
  }
  return 'stdio';
};

/**
 * Projects main-only discovered configuration onto the renderer allowlist. Keep this field-by-field:
 * spreading the discovery input would expose executable commands, arguments, endpoints, headers,
 * environment variables, credentials, or future main-only fields across IPC.
 */
const toMcpServerView = ({
  client,
  config,
  configPath,
  enabled,
  healthDetail,
  name,
  scope,
  toggleSupported,
}: DiscoveredServerInput): McpServerView =>
  Object.freeze({
    client,
    configPath,
    enabled,
    health: enabled ? 'unknown' : 'disabled',
    healthDetail,
    name,
    scope,
    toggleSupported,
    transport: serverTransport(config),
  });

const projectKey = (cwd: string): string => path.resolve(cwd).replaceAll('\\', '/').toLowerCase();

const findProjectRecord = (
  projects: Record<string, unknown>,
  cwd: string,
): [string, Record<string, unknown>] | undefined => {
  const key = projectKey(cwd);
  for (const [candidate, value] of Object.entries(projects)) {
    if (candidate.replaceAll('\\', '/').toLowerCase() === key && isRecord(value)) {
      return [candidate, value];
    }
  }
  return undefined;
};

const readProjectMcpServer = (cwd: string, name: string): ProjectMcpServerSnapshot => {
  const configPath = path.join(path.resolve(cwd), '.mcp.json');
  const bytes = readBounded(configPath, true);
  const value = decodeJson(bytes, configPath);
  if (!isRecord(value) || !isRecord(value.mcpServers)) {
    throw new Error('当前项目的 .mcp.json 未包含有效的 mcpServers 对象。');
  }
  const entries = Object.entries(value.mcpServers).filter(
    ([candidate, config]) => MCP_NAME.test(candidate) && isRecord(config),
  );
  const serverNames = new Set(entries.map(([candidate]) => candidate));
  const server = value.mcpServers[name];
  if (!MCP_NAME.test(name) || !serverNames.has(name) || !isRecord(server)) {
    throw new Error('只能启停当前项目 .mcp.json 中已发现的 Claude MCP 服务。');
  }
  return {
    bytes,
    digest: sha256(bytes),
    path: configPath,
    serverDigest: sha256(Buffer.from(JSON.stringify(server), 'utf8')),
    serverNames,
    server,
  };
};

const readProjectToggleNames = (
  project: Record<string, unknown>,
  field: 'disabledMcpjsonServers' | 'enabledMcpjsonServers',
  serverNames: ReadonlySet<string>,
): string[] => {
  const value = project[field];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((candidate): candidate is string => MCP_NAME.test(candidate))
  ) {
    throw new Error(`Claude Code 的 ${field} 必须是有效 MCP 名称数组。`);
  }
  const names = [...value];
  if (new Set(names).size !== names.length) {
    throw new Error(`Claude Code 的 ${field} 不能包含重复 MCP 名称。`);
  }
  if (names.some((candidate) => !serverNames.has(candidate))) {
    throw new Error(`Claude Code 的 ${field} 包含当前项目未发现的 MCP 服务。`);
  }
  return names;
};

const collectServers = (
  source: unknown,
  configPath: string,
  scope: McpServerView['scope'],
  client: McpServerView['client'],
  disabledNames: ReadonlySet<string> = new Set(),
): McpServerView[] => {
  if (!isRecord(source)) {
    return [];
  }
  return Object.entries(source)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        MCP_NAME.test(entry[0]) && isRecord(entry[1]),
    )
    .map(([name, config]) => {
      const enabled = !disabledNames.has(name);
      return toMcpServerView({
        client,
        config,
        configPath,
        enabled,
        healthDetail: enabled
          ? '目录读取不会执行连接检查。'
          : '已在项目的 disabledMcpjsonServers 中停用。',
        name,
        scope,
        toggleSupported: client === 'claude' && scope === 'project',
      });
    });
};

export const discoverMcpServers = (homeDirectory: string, cwd: string): McpServerView[] => {
  const claudePath = path.join(homeDirectory, '.claude.json');
  const projectMcpPath = path.join(path.resolve(cwd), '.mcp.json');
  const codexPath = path.join(homeDirectory, '.codex', 'config.toml');
  const claude = tryReadJsonRecord(claudePath);
  const projects = isRecord(claude.projects) ? claude.projects : {};
  const currentProject = findProjectRecord(projects, cwd)?.[1] ?? {};
  const disabled = new Set(
    Array.isArray(currentProject.disabledMcpjsonServers)
      ? currentProject.disabledMcpjsonServers.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  const projectMcp = tryReadJsonRecord(projectMcpPath);
  const discovered = [
    ...collectServers(claude.mcpServers, claudePath, 'user', 'claude'),
    ...collectServers(currentProject.mcpServers, claudePath, 'local', 'claude'),
    ...collectServers(projectMcp.mcpServers, projectMcpPath, 'project', 'claude', disabled),
  ];
  try {
    const toml = readBounded(codexPath).toString('utf8');
    for (const match of toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9._-]+)\]\s*$/gm)) {
      const name = match[1];
      if (
        !name ||
        !MCP_NAME.test(name) ||
        discovered.some((server) => server.client === 'codex' && server.name === name)
      ) {
        continue;
      }
      const sectionStart = (match.index ?? 0) + match[0].length;
      const section = toml.slice(sectionStart).split(/^\[/m, 1)[0] ?? '';
      const url = /^\s*url\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
      discovered.push(
        toMcpServerView({
          client: 'codex',
          config: url ? { type: 'http', url } : { type: 'stdio' },
          configPath: codexPath,
          enabled: true,
          healthDetail: '来自 Codex CLI；ClaudeDock 仅只读发现。',
          name,
          scope: 'user',
          toggleSupported: false,
        }),
      );
    }
  } catch {
    // A malformed, inaccessible, or oversized Codex source cannot hide Claude discoveries.
  }
  return discovered;
};

const registryRecordTimestamp = (record: McpRegistryRecord): number =>
  Math.max(
    ...[
      record.official.publishedAt,
      record.official.statusChangedAt,
      record.official.updatedAt,
    ].map((value) => (value === undefined ? Number.NEGATIVE_INFINITY : Date.parse(value))),
  );

const registryStatusRank = (record: McpRegistryRecord): number =>
  record.official.status === 'deleted' ? 2 : record.official.status === 'deprecated' ? 1 : 0;

const selectRegistryRecord = (records: readonly McpRegistryRecord[]): McpRegistryRecord => {
  const explicitLatest = records.filter((record) => record.official.isLatest === true);
  const candidates = explicitLatest.length > 0 ? explicitLatest : records;
  return candidates.reduce((selected, candidate) => {
    const selectedTimestamp = registryRecordTimestamp(selected);
    const candidateTimestamp = registryRecordTimestamp(candidate);
    if (candidateTimestamp !== selectedTimestamp) {
      return candidateTimestamp > selectedTimestamp ? candidate : selected;
    }
    const selectedStatus = registryStatusRank(selected);
    const candidateStatus = registryStatusRank(candidate);
    if (candidateStatus !== selectedStatus) {
      return candidateStatus > selectedStatus ? candidate : selected;
    }
    return candidate.identity > selected.identity ? candidate : selected;
  });
};

const registryTransport = (record: McpRegistryRecord): McpTransport => {
  const transports = [
    ...(record.remotes ?? []).map(({ type }) => type),
    ...(record.packages ?? []).map(({ transport }) => transport.type),
  ];
  if (transports.includes('streamable-http')) return 'http';
  if (transports.includes('sse')) return 'sse';
  return 'stdio';
};

const descriptorsRequireCredential = (
  descriptors: readonly McpRegistryInputFields[] | undefined,
): boolean =>
  descriptors?.some(
    (descriptor) =>
      descriptor.isSecret === true || descriptorsRequireCredential(descriptor.variables),
  ) ?? false;

const registryRequiresCredential = (record: McpRegistryRecord): boolean =>
  (record.packages ?? []).some(
    (alternative) =>
      descriptorsRequireCredential(alternative.environmentVariables) ||
      (alternative.transport.type !== 'stdio' &&
        descriptorsRequireCredential(alternative.transport.headers)),
  ) ||
  (record.remotes ?? []).some(
    (alternative) =>
      descriptorsRequireCredential(alternative.headers) ||
      descriptorsRequireCredential(alternative.variables),
  );

const projectRegistryEntries = (state: McpRegistryState): McpCatalogEntry[] => {
  const grouped = new Map<string, McpRegistryRecord[]>();
  for (const record of state.records) {
    const records = grouped.get(record.name) ?? [];
    records.push(record);
    grouped.set(record.name, records);
  }
  const entries: McpCatalogEntry[] = [];
  for (const records of grouped.values()) {
    const record = selectRegistryRecord(records);
    if (record.official.status === 'deleted') continue;
    entries.push({
      description: record.description,
      featured: false,
      id: `registry:${createHash('sha256').update(record.identity).digest('hex')}`,
      installable: false,
      name: record.name,
      requiresCredential: registryRequiresCredential(record),
      transport: registryTransport(record),
    });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
};

const registryStateMessage = (state: McpRegistryState): string => {
  if (state.mode === 'live') {
    return `官方注册表已${state.syncKind === 'full' ? '完整' : '增量'}同步`;
  }
  if (state.mode === 'snapshot') return '正在使用持久化注册表快照';
  if (state.mode === 'degraded' && state.records.length > 0) {
    return '注册表同步已降级，保留上次可用目录';
  }
  return '当前使用离线精选目录';
};

const lstatKind = (filePath: string, kind: 'file' | 'directory'): boolean => {
  try {
    const stats = lstatSync(filePath);
    return !stats.isSymbolicLink() && (kind === 'file' ? stats.isFile() : stats.isDirectory());
  } catch {
    return false;
  }
};

const backupIdFor = (timestamp: number): string =>
  `${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;

const updateProjectToggleState = (
  root: unknown,
  cwd: string,
  name: string,
  enabled: boolean,
  serverNames: ReadonlySet<string>,
): Record<string, unknown> => {
  if (!isRecord(root) || !isRecord(root.projects)) {
    throw new Error('Claude Code 项目 MCP 状态结构不存在。');
  }
  const found = findProjectRecord(root.projects, cwd);
  if (!found) {
    throw new Error('Claude Code 尚未记录当前项目。');
  }
  const [, project] = found;
  const enabledNames = new Set(
    readProjectToggleNames(project, 'enabledMcpjsonServers', serverNames),
  );
  const disabledNames = new Set(
    readProjectToggleNames(project, 'disabledMcpjsonServers', serverNames),
  );
  if ([...enabledNames].some((candidate) => disabledNames.has(candidate))) {
    throw new Error('Claude Code 的 MCP 启用和停用数组不能有交集。');
  }
  if (!serverNames.has(name)) {
    throw new Error('只能启停当前项目 .mcp.json 中已发现的 Claude MCP 服务。');
  }
  (enabled ? enabledNames : disabledNames).add(name);
  (enabled ? disabledNames : enabledNames).delete(name);
  project.enabledMcpjsonServers = [...enabledNames].sort();
  project.disabledMcpjsonServers = [...disabledNames].sort();
  return root;
};

/** Removes a project-scoped server from both Claude Code toggle arrays after CLI removal. */
const removeProjectToggleName = (root: unknown, cwd: string, name: string): boolean => {
  if (!isRecord(root) || !isRecord(root.projects)) return false;
  const found = findProjectRecord(root.projects, cwd);
  if (!found) return false;
  const [, project] = found;
  let changed = false;
  for (const field of ['enabledMcpjsonServers', 'disabledMcpjsonServers'] as const) {
    const value = project[field];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      !value.every((candidate): candidate is string => MCP_NAME.test(candidate))
    ) {
      throw new Error(`Claude Code 的 ${field} 必须是有效 MCP 名称数组。`);
    }
    const names = value.filter((candidate) => candidate !== name);
    if (names.length !== value.length) changed = true;
    project[field] = names;
  }
  return changed;
};

const removeProjectToggleNameFromFile = (
  targetPath: string,
  cwd: string,
  name: string,
): boolean => {
  const root = readJsonRecord(targetPath, true);
  if (!removeProjectToggleName(root, cwd, name)) return false;
  const temporary = `${targetPath}.claudedock-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, targetPath);
    return true;
  } finally {
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    } catch {
      // The completed rename is authoritative; a leftover temporary file is harmless and bounded.
    }
  }
};

export class McpManager {
  private readonly caches = new Map<string, AsyncRefreshCache<McpCatalog>>();
  private readonly catalogCacheTtlMs: number;
  private readonly fullCatalogRefreshes = new Map<string, Promise<McpCatalog>>();
  private readonly now: () => number;
  private pendingToggleMetadataBytes = 0;
  private pendingTogglePruneTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingToggles = new Map<string, PendingToggle>();
  private registryRevalidateAfter = Number.NEGATIVE_INFINITY;
  private readonly registryRevalidateIntervalMs: number;
  private registryRevalidation?: Promise<void>;

  public constructor(
    private readonly homeDirectory: string,
    private readonly userDataPath: string,
    private readonly busyRegistry: BusyRegistry,
    private readonly registryService: McpRegistrySyncService,
    options: McpManagerOptions = {},
  ) {
    this.catalogCacheTtlMs = nonnegativeSafeInteger(
      options.catalogCacheTtlMs ?? CATALOG_CACHE_TTL_MS,
      'catalogCacheTtlMs',
    );
    this.now = options.now ?? Date.now;
    this.registryRevalidateIntervalMs = nonnegativeSafeInteger(
      options.registryRevalidateIntervalMs ?? REGISTRY_REVALIDATE_INTERVAL_MS,
      'registryRevalidateIntervalMs',
    );
  }

  public getCatalog(cwd: string, forceRegistryRefresh = false): Promise<McpCatalog> {
    this.prunePendingToggles();
    const key = projectKey(cwd);
    let cache = this.caches.get(key);
    if (!cache) {
      cache = new AsyncRefreshCache<McpCatalog>(this.catalogCacheTtlMs, this.now);
      this.caches.set(key, cache);
    }
    if (!forceRegistryRefresh) {
      return cache.get(() => this.loadCatalog(cwd, false));
    }

    const activeFullRefresh = this.fullCatalogRefreshes.get(key);
    if (activeFullRefresh) return activeFullRefresh;
    const fullRefresh = this.loadCatalog(cwd, true)
      .then((catalog) => {
        cache.set(catalog);
        return catalog;
      })
      .finally(() => {
        if (this.fullCatalogRefreshes.get(key) === fullRefresh) {
          this.fullCatalogRefreshes.delete(key);
        }
      });
    this.fullCatalogRefreshes.set(key, fullRefresh);
    return fullRefresh;
  }

  public async install(input: McpInstallInput): Promise<string> {
    const installSpec = CURATED_MCP_INSTALL_SPECS.get(input.catalogId);
    if (!installSpec) {
      throw new Error('该 MCP 条目不在 ClaudeDock 直接安装白名单中。');
    }
    const config = structuredClone(installSpec.config);
    if (Array.isArray(config.args)) {
      config.args = config.args.map((argument) =>
        argument === '{{cwd}}' ? path.resolve(input.cwd) : argument,
      );
    }
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:install:${installSpec.name}:${input.scope}`,
      kind: 'install',
      label: `正在安装 MCP ${installSpec.name}`,
      severity: 'blocking',
    });
    try {
      await runWindowsCommand(
        'claude',
        ['mcp', 'add-json', '--scope', input.scope, installSpec.name, JSON.stringify(config)],
        { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
      );
      this.invalidate(input.cwd);
      return `MCP ${installSpec.name} 已安装到 ${input.scope} 作用域。`;
    } finally {
      release();
    }
  }

  public async remove(input: McpRemoveInput): Promise<string> {
    if (!MCP_NAME.test(input.name)) {
      throw new Error('MCP 名称无效。');
    }
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:remove:${input.name}:${input.scope}`,
      kind: 'uninstall',
      label: `正在卸载 MCP ${input.name}`,
      severity: 'blocking',
    });
    try {
      await runWindowsCommand('claude', ['mcp', 'remove', '--scope', input.scope, input.name], {
        cwd: input.cwd,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      });
      if (input.scope === 'project') {
        removeProjectToggleNameFromFile(
          path.join(this.homeDirectory, '.claude.json'),
          input.cwd,
          input.name,
        );
      }
      this.invalidate(input.cwd);
      return `MCP ${input.name} 已从 ${input.scope} 作用域移除。`;
    } finally {
      release();
    }
  }

  public previewToggle(cwd: string, name: string, enabled: boolean): McpTogglePreview {
    if (!MCP_NAME.test(name)) {
      throw new Error('MCP 名称无效。');
    }
    this.prunePendingToggles();
    if (this.pendingToggles.size >= MAX_PENDING_TOGGLES) {
      throw new Error('待确认的 MCP 改动过多，请先确认或取消已有预览。');
    }
    const projectCwd = path.resolve(cwd);
    if (Buffer.byteLength(projectCwd, 'utf8') > MAX_PENDING_TOGGLE_METADATA_BYTES) {
      throw new Error('待确认的 MCP 改动元数据过大，请缩短项目路径后重试。');
    }
    const projectMcp = readProjectMcpServer(projectCwd, name);
    const targetPath = path.join(this.homeDirectory, '.claude.json');
    const beforeBytes = readBounded(targetPath, true);
    updateProjectToggleState(
      decodeJson(beforeBytes, targetPath),
      projectCwd,
      name,
      enabled,
      projectMcp.serverNames,
    );
    const preview: McpTogglePreview = {
      after: `${enabled ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers'} += ${name}`,
      before: `${enabled ? 'disabledMcpjsonServers' : 'enabledMcpjsonServers'} -= ${name}`,
      enabled,
      id: randomUUID(),
      name,
      targetPath,
    };
    const beforeDigest = sha256(beforeBytes);
    const retainedBytes = Buffer.byteLength(
      [
        beforeDigest,
        projectCwd,
        projectMcp.digest,
        projectMcp.serverDigest,
        preview.after,
        preview.before,
        preview.id,
        name,
        targetPath,
      ].join('\0'),
      'utf8',
    );
    if (this.pendingToggleMetadataBytes + retainedBytes > MAX_PENDING_TOGGLE_METADATA_BYTES) {
      throw new Error('待确认的 MCP 改动元数据过大，请先确认或取消已有预览。');
    }
    this.pendingToggles.set(preview.id, {
      beforeDigest,
      cwd: projectCwd,
      expiresAt: this.now() + TOGGLE_PREVIEW_TTL_MS,
      projectMcpDigest: projectMcp.digest,
      projectMcpServerDigest: projectMcp.serverDigest,
      preview,
      retainedBytes,
    });
    this.pendingToggleMetadataBytes += retainedBytes;
    this.refreshPendingTogglePruneTimer();
    return preview;
  }

  public discardToggle(previewId: string): boolean {
    const discarded = this.takePendingToggle(previewId) !== undefined;
    this.refreshPendingTogglePruneTimer();
    return discarded;
  }

  public async applyToggle(previewId: string, expectedCwd?: string): Promise<string> {
    const pending = this.takePendingToggle(previewId);
    this.refreshPendingTogglePruneTimer();
    if (!pending || pending.expiresAt <= this.now()) {
      throw new Error('MCP 改动预览已过期，请重新确认。');
    }
    if (expectedCwd !== undefined && projectKey(expectedCwd) !== projectKey(pending.cwd)) {
      throw new Error('MCP 改动预览所属项目与当前项目不一致，请重新确认。');
    }
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:toggle:${pending.preview.name}`,
      kind: 'configure',
      label: `正在${pending.preview.enabled ? '启用' : '停用'} MCP ${pending.preview.name}`,
      severity: 'blocking',
    });
    const rollback = new RollbackCoordinator();
    const backupId = backupIdFor(this.now());
    const backupDirectory = path.join(this.userDataPath, 'mcp-backups', backupId);
    const backupPath = path.join(backupDirectory, 'claude.json');
    try {
      const current = readBounded(pending.preview.targetPath, true);
      if (sha256(current) !== pending.beforeDigest) {
        throw new Error('预览后配置文件已被其他程序修改；未写入任何内容。');
      }
      const projectMcp = readProjectMcpServer(pending.cwd, pending.preview.name);
      if (
        projectMcp.digest !== pending.projectMcpDigest ||
        projectMcp.serverDigest !== pending.projectMcpServerDigest
      ) {
        throw new Error('预览后项目 MCP 配置已被其他程序修改；未写入任何内容。');
      }
      const root = updateProjectToggleState(
        decodeJson(current, pending.preview.targetPath),
        pending.cwd,
        pending.preview.name,
        pending.preview.enabled,
        projectMcp.serverNames,
      );
      const afterBytes = Buffer.from(`${JSON.stringify(root, null, 2)}\n`, 'utf8');
      mkdirSync(backupDirectory, { recursive: true });
      writeFileSync(backupPath, current, { flag: 'wx', mode: 0o600 });
      rollback.add(() => copyFileSync(backupPath, pending.preview.targetPath));
      const temporary = `${pending.preview.targetPath}.claudedock-${process.pid}.tmp`;
      writeFileSync(temporary, afterBytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, pending.preview.targetPath);
      rollback.commit();
      this.pruneBackups();
      this.invalidate(pending.cwd);
      return `MCP ${pending.preview.name} 已${pending.preview.enabled ? '启用' : '停用'}；备份保存在 ${backupPath}。`;
    } catch (error) {
      try {
        await rollback.rollback();
      } catch {
        // Recovery is best effort; preserve the mutation error as the authoritative failure.
      }
      throw error;
    } finally {
      release();
    }
  }

  public listBackups(): McpBackupView[] {
    const root = path.join(this.userDataPath, 'mcp-backups');
    if (!lstatKind(root, 'directory')) return [];
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && BACKUP_ID.test(entry.name))
      .map((entry) => {
        const backupDirectory = path.join(root, entry.name);
        const backupPath = path.join(backupDirectory, 'claude.json');
        if (!lstatKind(backupDirectory, 'directory') || !lstatKind(backupPath, 'file')) {
          return undefined;
        }
        try {
          return {
            createdAt: lstatSync(backupPath).mtimeMs,
            id: entry.name,
            path: backupPath,
          };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is McpBackupView => entry !== undefined)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  public async restoreBackup(backupId: string, cwd: string): Promise<string> {
    if (!BACKUP_ID.test(backupId)) throw new Error('MCP 备份标识无效。');
    const root = path.resolve(this.userDataPath, 'mcp-backups');
    const backupDirectory = path.resolve(root, backupId);
    const backupPath = path.resolve(backupDirectory, 'claude.json');
    if (
      path.dirname(backupDirectory) !== root ||
      path.dirname(path.dirname(backupPath)) !== root ||
      !lstatKind(root, 'directory') ||
      !lstatKind(backupDirectory, 'directory') ||
      !lstatKind(backupPath, 'file')
    ) {
      throw new Error('MCP 备份不存在或已被清理。');
    }
    const targetPath = path.join(this.homeDirectory, '.claude.json');
    if (!lstatKind(targetPath, 'file')) {
      throw new Error('MCP 当前配置不存在或不是普通文件。');
    }
    const backupBytes = readBounded(backupPath, true);
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:restore:${backupId}`,
      kind: 'configure',
      label: '正在还原 MCP 配置备份',
      severity: 'blocking',
    });
    const rollback = new RollbackCoordinator();
    const safetyId = backupIdFor(this.now());
    const safetyDirectory = path.join(root, safetyId);
    const safetyPath = path.join(safetyDirectory, 'claude.json');
    try {
      const currentBytes = readBounded(targetPath, true);
      mkdirSync(safetyDirectory, { recursive: true });
      writeFileSync(safetyPath, currentBytes, { flag: 'wx', mode: 0o600 });
      rollback.add(() => copyFileSync(safetyPath, targetPath));
      const temporary = `${targetPath}.claudedock-${process.pid}.tmp`;
      writeFileSync(temporary, backupBytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, targetPath);
      rollback.commit();
      this.invalidate(cwd);
      this.pruneBackups();
      return `已逐字节还原 MCP 备份 ${backupId}；还原前状态另存为 ${safetyPath}。`;
    } catch (error) {
      try {
        await rollback.rollback();
      } catch {
        // Recovery is best effort; preserve the restore error as the authoritative failure.
      }
      throw error;
    } finally {
      release();
    }
  }

  private clearCatalogCaches(): void {
    for (const cache of this.caches.values()) cache.clear();
  }

  private invalidate(cwd: string): void {
    this.caches.get(projectKey(cwd))?.clear();
  }

  private async loadCatalog(cwd: string, forceRegistryRefresh: boolean): Promise<McpCatalog> {
    /*
     * Catalog reads are intentionally inert. Project-defined MCP configuration is untrusted input:
     * discovering it must never execute stdio commands or contact its remote endpoints. A future
     * connectivity check needs a separate main-owned consent flow bound to the exact config digest.
     */
    const installed = discoverMcpServers(this.homeDirectory, cwd);
    let registryState = this.registryService.getState();
    if (forceRegistryRefresh) {
      const previousRevision = this.registryService.getContentRevision();
      registryState = await this.registryService.synchronizeFull();
      this.registryRevalidateAfter = this.now() + this.registryRevalidateIntervalMs;
      if (this.registryService.getContentRevision() !== previousRevision) {
        this.clearCatalogCaches();
      }
    } else {
      this.startRegistryRevalidation();
    }
    return {
      available: [...CURATED_MCP_SERVERS, ...projectRegistryEntries(registryState)],
      checkedAt: this.now(),
      installed,
      message: `发现 ${installed.length} 个 MCP；${registryStateMessage(registryState)}。`,
      registryAvailable: registryState.mode === 'live',
    };
  }

  private startRegistryRevalidation(): void {
    const now = this.now();
    if (this.registryRevalidation || now < this.registryRevalidateAfter) return;
    const previousRevision = this.registryService.getContentRevision();
    this.registryRevalidateAfter = now + this.registryRevalidateIntervalMs;
    const revalidation = this.registryService
      .synchronizeIncremental()
      .then(() => {
        if (this.registryService.getContentRevision() !== previousRevision) {
          this.clearCatalogCaches();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.registryRevalidation === revalidation) this.registryRevalidation = undefined;
      });
    this.registryRevalidation = revalidation;
  }

  private takePendingToggle(previewId: string): PendingToggle | undefined {
    const pending = this.pendingToggles.get(previewId);
    if (!pending) return undefined;
    this.pendingToggles.delete(previewId);
    this.pendingToggleMetadataBytes = Math.max(
      0,
      this.pendingToggleMetadataBytes - pending.retainedBytes,
    );
    return pending;
  }

  private refreshPendingTogglePruneTimer(): void {
    if (this.pendingTogglePruneTimer) clearTimeout(this.pendingTogglePruneTimer);
    this.pendingTogglePruneTimer = undefined;
    const nextExpiry = Math.min(
      ...[...this.pendingToggles.values()].map(({ expiresAt }) => expiresAt),
    );
    if (!Number.isFinite(nextExpiry)) return;
    this.pendingTogglePruneTimer = setTimeout(
      () => {
        this.pendingTogglePruneTimer = undefined;
        this.prunePendingToggles();
      },
      Math.max(0, nextExpiry - this.now()),
    );
    this.pendingTogglePruneTimer.unref?.();
  }

  private prunePendingToggles(now = this.now()): void {
    for (const [previewId, pending] of this.pendingToggles) {
      if (pending.expiresAt <= now) this.takePendingToggle(previewId);
    }
    this.refreshPendingTogglePruneTimer();
  }

  private pruneBackups(): void {
    const root = path.join(this.userDataPath, 'mcp-backups');
    if (!existsSync(root)) return;
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const directory of directories.slice(10)) {
      rmSync(path.join(root, directory), { force: true, recursive: true });
    }
  }
}
