import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  McpCatalog,
  McpCatalogEntry,
  McpBackupView,
  McpInstallInput,
  McpRemoveInput,
  McpServerView,
  McpTogglePreview,
  McpTransport,
} from '../shared/contracts';
import { CURATED_MCP_SERVERS } from '../shared/mcp-catalog';
import { AsyncRefreshCache } from './async-refresh-cache';
import { BackgroundTaskCoordinator } from './background-task-coordinator';
import type { BusyRegistry } from './busy-registry';
import { RollbackCoordinator } from './rollback-coordinator';
import { resolveWindowsCommandInvocation, runWindowsCommand } from './windows-command';

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers?limit=50';

interface DiscoveredServer extends McpServerView {
  config: Record<string, unknown>;
}

interface PendingToggle {
  afterBytes: Buffer;
  beforeDigest: string;
  cwd: string;
  expiresAt: number;
  preview: McpTogglePreview;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const readBounded = (filePath: string): Buffer => {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
    throw new Error(`MCP 配置文件大小异常：${filePath}`);
  }
  return readFileSync(filePath);
};

const readJsonRecord = (filePath: string): Record<string, unknown> => {
  if (!existsSync(filePath)) {
    return {};
  }
  const value: unknown = JSON.parse(readBounded(filePath).toString('utf8'));
  return isRecord(value) ? value : {};
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

const collectServers = (
  source: unknown,
  configPath: string,
  scope: McpServerView['scope'],
  client: McpServerView['client'],
  disabledNames: ReadonlySet<string> = new Set(),
): DiscoveredServer[] => {
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
      return {
        client,
        config,
        configPath,
        enabled,
        health: enabled ? 'unknown' : 'disabled',
        healthDetail: enabled ? '尚未执行健康检查。' : '已在项目的 disabledMcpjsonServers 中停用。',
        name,
        scope,
        toggleSupported: client === 'claude' && scope === 'project',
        transport: serverTransport(config),
      };
    });
};

export const discoverMcpServers = (homeDirectory: string, cwd: string): DiscoveredServer[] => {
  const claudePath = path.join(homeDirectory, '.claude.json');
  const projectMcpPath = path.join(cwd, '.mcp.json');
  const codexPath = path.join(homeDirectory, '.codex', 'config.toml');
  const claude = readJsonRecord(claudePath);
  const projects = isRecord(claude.projects) ? claude.projects : {};
  const currentProject = findProjectRecord(projects, cwd)?.[1] ?? {};
  const disabled = new Set(
    Array.isArray(currentProject.disabledMcpjsonServers)
      ? currentProject.disabledMcpjsonServers.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  const projectMcp = readJsonRecord(projectMcpPath);
  const discovered = [
    ...collectServers(claude.mcpServers, claudePath, 'user', 'claude'),
    ...collectServers(currentProject.mcpServers, claudePath, 'local', 'claude'),
    ...collectServers(projectMcp.mcpServers, projectMcpPath, 'project', 'claude', disabled),
  ];
  if (existsSync(codexPath)) {
    const toml = readBounded(codexPath).toString('utf8');
    for (const match of toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9._-]+)\]\s*$/gm)) {
      const name = match[1];
      if (!name || discovered.some((server) => server.client === 'codex' && server.name === name)) {
        continue;
      }
      const sectionStart = (match.index ?? 0) + match[0].length;
      const section = toml.slice(sectionStart).split(/^\[/m, 1)[0] ?? '';
      const url = /^\s*url\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
      discovered.push({
        client: 'codex',
        config: url ? { type: 'http', url } : { type: 'stdio' },
        configPath: codexPath,
        enabled: true,
        health: 'unknown',
        healthDetail: '来自 Codex CLI；ClaudeDock 仅只读发现。',
        name,
        scope: 'user',
        toggleSupported: false,
        transport: url ? 'http' : 'stdio',
      });
    }
  }
  return discovered;
};

const registryEntries = (value: unknown): McpCatalogEntry[] => {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    throw new Error('MCP 注册表响应格式无效。');
  }
  const entries: McpCatalogEntry[] = [];
  for (const wrapper of value.servers) {
    const server = isRecord(wrapper) && isRecord(wrapper.server) ? wrapper.server : undefined;
    const registryName = optionalString(server?.name);
    const remote = Array.isArray(server?.remotes)
      ? server.remotes.find((item) => isRecord(item) && optionalString(item.url))
      : undefined;
    const url = isRecord(remote) ? optionalString(remote.url) : undefined;
    const name = registryName
      ?.split('/')
      .at(-1)
      ?.replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    if (
      !registryName ||
      !name ||
      !MCP_NAME.test(name) ||
      !url ||
      entries.some((entry) => entry.name === name)
    ) {
      continue;
    }
    entries.push({
      config: { type: 'http', url },
      description: optionalString(server?.description) ?? '官方注册表未提供说明。',
      featured: false,
      id: `registry:${registryName}`,
      name,
      officialUrl: url,
      requiresCredential: false,
      transport: 'http',
    });
  }
  return entries;
};

const safeHealthError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer|token|key)\s*[:=]?\s*[^\s"']+/gi, '[凭据已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .slice(0, 240);

export class McpManager {
  private readonly caches = new Map<string, AsyncRefreshCache<McpCatalog>>();
  private readonly pendingToggles = new Map<string, PendingToggle>();
  private readonly tasks = new BackgroundTaskCoordinator(2);
  private registryEntries?: McpCatalogEntry[];

  public constructor(
    private readonly homeDirectory: string,
    private readonly userDataPath: string,
    private readonly busyRegistry: BusyRegistry,
  ) {}

  public getCatalog(cwd: string, refresh = false): Promise<McpCatalog> {
    const key = projectKey(cwd);
    let cache = this.caches.get(key);
    if (!cache) {
      cache = new AsyncRefreshCache<McpCatalog>(10_000);
      this.caches.set(key, cache);
    }
    return cache.get(() => this.loadCatalog(cwd, refresh), refresh);
  }

  public async install(input: McpInstallInput): Promise<string> {
    const catalog = await this.getCatalog(input.cwd);
    const entry = catalog.available.find((candidate) => candidate.id === input.catalogId);
    if (!entry || entry.requiresCredential) {
      throw new Error('该 MCP 条目不能无凭据自动安装。');
    }
    const config = structuredClone(entry.config);
    if (Array.isArray(config.args)) {
      config.args = config.args.map((argument) =>
        argument === '{{cwd}}' ? path.resolve(input.cwd) : argument,
      );
    }
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:install:${entry.name}:${input.scope}`,
      kind: 'install',
      label: `正在安装 MCP ${entry.name}`,
      severity: 'blocking',
    });
    try {
      await runWindowsCommand(
        'claude',
        ['mcp', 'add-json', '--scope', input.scope, entry.name, JSON.stringify(config)],
        { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
      );
      this.invalidate(input.cwd);
      return `MCP ${entry.name} 已安装到 ${input.scope} 作用域。`;
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
    const targetPath = path.join(this.homeDirectory, '.claude.json');
    const beforeBytes = readBounded(targetPath);
    const root: unknown = JSON.parse(beforeBytes.toString('utf8'));
    if (!isRecord(root) || !isRecord(root.projects)) {
      throw new Error('Claude Code 项目 MCP 状态结构不存在。');
    }
    const found = findProjectRecord(root.projects, cwd);
    if (!found) {
      throw new Error('Claude Code 尚未记录当前项目。');
    }
    const [, project] = found;
    const enabledNames = new Set(
      Array.isArray(project.enabledMcpjsonServers)
        ? project.enabledMcpjsonServers.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
    const disabledNames = new Set(
      Array.isArray(project.disabledMcpjsonServers)
        ? project.disabledMcpjsonServers.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
    (enabled ? enabledNames : disabledNames).add(name);
    (enabled ? disabledNames : enabledNames).delete(name);
    project.enabledMcpjsonServers = [...enabledNames].sort();
    project.disabledMcpjsonServers = [...disabledNames].sort();
    const afterBytes = Buffer.from(`${JSON.stringify(root, null, 2)}\n`, 'utf8');
    const preview: McpTogglePreview = {
      after: `${enabled ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers'} += ${name}`,
      before: `${enabled ? 'disabledMcpjsonServers' : 'enabledMcpjsonServers'} -= ${name}`,
      enabled,
      id: randomUUID(),
      name,
      targetPath,
    };
    this.pendingToggles.set(preview.id, {
      afterBytes,
      beforeDigest: sha256(beforeBytes),
      cwd,
      expiresAt: Date.now() + 5 * 60_000,
      preview,
    });
    return preview;
  }

  public async applyToggle(previewId: string): Promise<string> {
    const pending = this.pendingToggles.get(previewId);
    this.pendingToggles.delete(previewId);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new Error('MCP 改动预览已过期，请重新确认。');
    }
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:toggle:${pending.preview.name}`,
      kind: 'configure',
      label: `正在${pending.preview.enabled ? '启用' : '停用'} MCP ${pending.preview.name}`,
      severity: 'blocking',
    });
    const rollback = new RollbackCoordinator();
    const backupDirectory = path.join(
      this.userDataPath,
      'mcp-backups',
      new Date().toISOString().replace(/[:.]/g, '-'),
    );
    const backupPath = path.join(backupDirectory, 'claude.json');
    try {
      const current = readBounded(pending.preview.targetPath);
      if (sha256(current) !== pending.beforeDigest) {
        throw new Error('预览后配置文件已被其他程序修改；未写入任何内容。');
      }
      mkdirSync(backupDirectory, { recursive: true });
      copyFileSync(pending.preview.targetPath, backupPath);
      rollback.add(() => copyFileSync(backupPath, pending.preview.targetPath));
      const temporary = `${pending.preview.targetPath}.claudedock-${process.pid}.tmp`;
      writeFileSync(temporary, pending.afterBytes, { flag: 'wx' });
      renameSync(temporary, pending.preview.targetPath);
      rollback.commit();
      this.pruneBackups();
      this.invalidate(pending.cwd);
      return `MCP ${pending.preview.name} 已${pending.preview.enabled ? '启用' : '停用'}；备份保存在 ${backupPath}。`;
    } catch (error) {
      await rollback.rollback();
      throw error;
    } finally {
      release();
    }
  }

  public listBackups(): McpBackupView[] {
    const root = path.join(this.userDataPath, 'mcp-backups');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9TZ-]+$/.test(entry.name))
      .map((entry) => {
        const backupPath = path.join(root, entry.name, 'claude.json');
        if (!existsSync(backupPath)) return undefined;
        return {
          createdAt: statSync(backupPath).mtimeMs,
          id: entry.name,
          path: backupPath,
        };
      })
      .filter((entry): entry is McpBackupView => entry !== undefined)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  public async restoreBackup(backupId: string, cwd: string): Promise<string> {
    if (!/^[0-9TZ-]+$/.test(backupId)) throw new Error('MCP 备份标识无效。');
    const root = path.resolve(this.userDataPath, 'mcp-backups');
    const backupPath = path.resolve(root, backupId, 'claude.json');
    if (path.dirname(path.dirname(backupPath)) !== root || !existsSync(backupPath)) {
      throw new Error('MCP 备份不存在或已被清理。');
    }
    const targetPath = path.join(this.homeDirectory, '.claude.json');
    const release = this.busyRegistry.acquire({
      cancellable: false,
      id: `mcp:restore:${backupId}`,
      kind: 'configure',
      label: '正在还原 MCP 配置备份',
      severity: 'blocking',
    });
    const rollback = new RollbackCoordinator();
    const safetyDirectory = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
    const safetyPath = path.join(safetyDirectory, 'claude.json');
    try {
      mkdirSync(safetyDirectory, { recursive: true });
      copyFileSync(targetPath, safetyPath);
      rollback.add(() => copyFileSync(safetyPath, targetPath));
      const temporary = `${targetPath}.claudedock-${process.pid}.tmp`;
      copyFileSync(backupPath, temporary);
      renameSync(temporary, targetPath);
      rollback.commit();
      this.invalidate(cwd);
      this.pruneBackups();
      return `已逐字节还原 MCP 备份 ${backupId}；还原前状态另存为 ${safetyPath}。`;
    } catch (error) {
      await rollback.rollback();
      throw error;
    } finally {
      release();
    }
  }

  private invalidate(cwd: string): void {
    this.caches.get(projectKey(cwd))?.clear();
  }

  private async loadCatalog(cwd: string, refreshHealth: boolean): Promise<McpCatalog> {
    let installed = discoverMcpServers(this.homeDirectory, cwd);
    if (refreshHealth) {
      installed = await Promise.all(
        installed.map((server) =>
          this.tasks.run(
            `mcp-health:${server.client}:${server.scope}:${server.name}`,
            'interactive',
            () => this.checkHealth(server, cwd),
          ),
        ),
      );
    }
    if (refreshHealth) {
      try {
        await this.refreshRegistry();
      } catch {
        // Curated entries remain fully usable offline.
      }
    } else {
      void this.refreshRegistry()
        .then(() => {
          for (const cache of this.caches.values()) cache.clear();
        })
        .catch(() => undefined);
    }
    const online = this.registryEntries ?? [];
    const registryAvailable = this.registryEntries !== undefined;
    const curatedNames = new Set(CURATED_MCP_SERVERS.map((entry) => entry.name));
    const available = [
      ...CURATED_MCP_SERVERS,
      ...online.filter((entry) => !curatedNames.has(entry.name)),
    ];
    return {
      available,
      checkedAt: Date.now(),
      installed,
      message: `发现 ${installed.length} 个 MCP；${registryAvailable ? '官方注册表已连接' : '当前使用离线精选目录'}。`,
      registryAvailable,
    };
  }

  private refreshRegistry(): Promise<McpCatalogEntry[]> {
    return this.tasks
      .run('mcp-registry', 'background', async () => {
        const response = await fetch(REGISTRY_URL, {
          headers: { accept: 'application/json', 'user-agent': 'ClaudeDock/3' },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_REGISTRY_BYTES) throw new Error('MCP 注册表响应过大。');
        return registryEntries(JSON.parse(bytes.toString('utf8')) as unknown);
      })
      .then((entries) => {
        this.registryEntries = entries;
        return entries;
      });
  }

  private async checkHealth(server: DiscoveredServer, cwd: string): Promise<DiscoveredServer> {
    if (!server.enabled) {
      return server;
    }
    try {
      if (server.transport === 'http' || server.transport === 'sse') {
        const url = optionalString(server.config.url);
        if (!url || new URL(url).protocol !== 'https:') {
          throw new Error('远程 MCP 必须使用 HTTPS 地址。');
        }
        const response = await fetch(url, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
              capabilities: {},
              clientInfo: { name: 'ClaudeDock health check', version: '3.0.0' },
              protocolVersion: '2025-06-18',
            },
          }),
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(`初始化请求返回 HTTP ${response.status}。`);
        }
      } else {
        await this.checkStdioHealth(server, cwd);
      }
      return { ...server, health: 'connected', healthDetail: 'MCP initialize 握手成功。' };
    } catch (error) {
      return { ...server, health: 'failed', healthDetail: safeHealthError(error) };
    }
  }

  private async checkStdioHealth(server: DiscoveredServer, cwd: string): Promise<void> {
    const command = optionalString(server.config.command);
    const args = Array.isArray(server.config.args)
      ? server.config.args.filter((value): value is string => typeof value === 'string')
      : [];
    if (!command || command.length > 260 || /[\r\n\0]/.test(command)) {
      throw new Error('stdio MCP 命令无效。');
    }
    const invocation = await resolveWindowsCommandInvocation(command, { cwd });
    const configuredEnvironment = isRecord(server.config.env)
      ? Object.fromEntries(
          Object.entries(server.config.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.executable, [...invocation.argumentsPrefix, ...args], {
        cwd,
        env: { ...process.env, ...configuredEnvironment },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let settled = false;
      let output = '';
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => finish(new Error('initialize 握手 10 秒内没有响应。')),
        10_000,
      );
      timer.unref();
      child.on('error', (error) => finish(error));
      child.stdout.on('data', (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-64 * 1024);
        if (/"jsonrpc"\s*:\s*"2\.0"/.test(output) && /"id"\s*:\s*1/.test(output)) {
          finish();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-64 * 1024);
      });
      child.on('close', () => finish(new Error(output.trim() || 'MCP 进程在握手前退出。')));
      child.stdin.end(
        `${JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            capabilities: {},
            clientInfo: { name: 'ClaudeDock health check', version: '3.0.0' },
            protocolVersion: '2025-06-18',
          },
        })}\n`,
      );
    });
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
