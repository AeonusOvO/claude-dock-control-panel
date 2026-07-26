import type {
  ClaudePluginCatalog,
  ClaudePluginMarketplaceView,
  ClaudePluginScope,
  ClaudePluginView,
} from '../shared/contracts';
import { runWindowsCommand } from './windows-command';

const LIST_TIMEOUT_MS = 120_000;
const MUTATION_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * `plugin@marketplace` as printed by `claude plugin list --json --available`. Both halves are
 * restricted so the identifier can never be read as an option or a shell fragment.
 */
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$/;
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const isValidPluginId = (value: unknown): value is string =>
  typeof value === 'string' && PLUGIN_ID.test(value);

export const isValidMarketplaceName = (value: unknown): value is string =>
  typeof value === 'string' && MARKETPLACE_NAME.test(value);

/**
 * A marketplace source may be a GitHub `owner/repo`, an https URL or an absolute local path.
 * Anything else — including `-`-prefixed strings that would be parsed as CLI options — is refused.
 */
export const isValidMarketplaceSource = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 400 || trimmed.startsWith('-') || /[\r\n\0]/.test(trimmed)) {
    return false;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return true;
  }
  try {
    return new URL(trimmed).protocol === 'https:';
  } catch {
    return false;
  }
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optionalCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const scopeOf = (value: unknown): ClaudePluginScope | undefined =>
  value === 'local' || value === 'project' || value === 'user' ? value : undefined;

/** The CLI prints `source` either as a bare relative path or as a git descriptor object. */
export const describePluginSource = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '未知来源';
  }
  const record = value as Record<string, unknown>;
  const url = optionalString(record.url);
  const subPath = optionalString(record.path);
  const ref = optionalString(record.ref);
  const label = url
    ? url.replace(/^https:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '')
    : (optionalString(record.source) ?? '未知来源');
  return [label, subPath, ref && `@${ref}`].filter(Boolean).join(' · ');
};

export const parsePluginEntry = (value: unknown, installed: boolean): ClaudePluginView | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sourceRecord =
    record.source && typeof record.source === 'object'
      ? (record.source as Record<string, unknown>)
      : undefined;
  const name = optionalString(record.name);
  const marketplaceName = optionalString(record.marketplaceName) ?? '';
  const pluginId =
    optionalString(record.pluginId) ??
    (name && marketplaceName ? `${name}@${marketplaceName}` : name);
  if (!name || !pluginId || !isValidPluginId(pluginId)) {
    return null;
  }

  return {
    description: optionalString(record.description) ?? '这个插件没有提供说明。',
    // The CLI omits `enabled` for available plugins and for enabled installs alike.
    enabled: installed ? record.enabled !== false : false,
    installCount: optionalCount(record.installCount),
    installed,
    marketplaceName: marketplaceName || pluginId.split('@')[1] || '本地',
    name,
    pluginId,
    scope: scopeOf(record.scope),
    sourceLabel: describePluginSource(record.source),
    sourceRevision: optionalString(sourceRecord?.sha),
    latestVersion: optionalString(record.latestVersion),
    updateAvailable: record.updateAvailable === true,
    version: optionalString(record.version),
  };
};

export const parsePluginCatalog = (
  raw: string,
): { available: ClaudePluginView[]; installed: ClaudePluginView[] } => {
  const parsed: unknown = JSON.parse(raw);
  const collect = (value: unknown, installed: boolean): ClaudePluginView[] =>
    Array.isArray(value)
      ? value
          .map((entry) => parsePluginEntry(entry, installed))
          .filter((entry): entry is ClaudePluginView => entry !== null)
      : [];

  if (Array.isArray(parsed)) {
    return { available: [], installed: collect(parsed, true) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { available: [], installed: [] };
  }

  const record = parsed as Record<string, unknown>;
  const availableCatalog = collect(record.available, false);
  const availableById = new Map(
    availableCatalog.map((plugin) => [plugin.pluginId, plugin] as const),
  );
  const installed = collect(record.installed, true).map((plugin) => {
    const latest = availableById.get(plugin.pluginId);
    const latestVersion = plugin.latestVersion ?? latest?.version;
    const latestSourceRevision = latest?.sourceRevision;
    return {
      ...plugin,
      latestVersion,
      latestSourceRevision,
      updateAvailable:
        plugin.updateAvailable ||
        Boolean(plugin.version && latestVersion && plugin.version !== latestVersion) ||
        Boolean(
          plugin.sourceRevision &&
          latestSourceRevision &&
          plugin.sourceRevision !== latestSourceRevision,
        ),
    };
  });
  const installedIds = new Set(installed.map((plugin) => plugin.pluginId));
  const available = availableCatalog.filter((plugin) => !installedIds.has(plugin.pluginId));
  return { available, installed };
};

export const parseMarketplaces = (raw: string): ClaudePluginMarketplaceView[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const marketplaces: ClaudePluginMarketplaceView[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = optionalString(record.name);
    if (!name) {
      continue;
    }
    marketplaces.push({
      installLocation: optionalString(record.installLocation),
      name,
      repo: optionalString(record.repo),
      source: optionalString(record.source) ?? '未知',
    });
  }
  return marketplaces;
};

const emptyCatalog = (message: string, cliAvailable: boolean): ClaudePluginCatalog => ({
  available: [],
  checkedAt: Date.now(),
  cliAvailable,
  installed: [],
  marketplaces: [],
  message,
  updatesAvailable: 0,
});

export class ClaudePluginManager {
  private cached?: ClaudePluginCatalog;
  private inFlight?: Promise<ClaudePluginCatalog>;

  public constructor(private readonly cwd: string) {}

  /** Returns the cached catalog unless `refresh` is set; concurrent refreshes are coalesced. */
  public async getCatalog(refresh = false): Promise<ClaudePluginCatalog> {
    if (!refresh && this.cached) {
      return this.cached;
    }
    this.inFlight ??= this.loadCatalog().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public async install(pluginId: string): Promise<string> {
    await this.run(['plugin', 'install', pluginId, '--scope', 'user'], MUTATION_TIMEOUT_MS);
    return `插件 ${pluginId} 已安装。重启 Claude 会话后生效。`;
  }

  public async uninstall(pluginId: string): Promise<string> {
    await this.run(
      ['plugin', 'uninstall', pluginId, '--scope', 'user', '--yes'],
      MUTATION_TIMEOUT_MS,
    );
    return `插件 ${pluginId} 已卸载。`;
  }

  public async setEnabled(pluginId: string, enabled: boolean): Promise<string> {
    await this.run(
      ['plugin', enabled ? 'enable' : 'disable', pluginId, '--scope', 'user'],
      MUTATION_TIMEOUT_MS,
    );
    return `插件 ${pluginId} 已${enabled ? '启用' : '停用'}。重启 Claude 会话后生效。`;
  }

  public async update(pluginId: string): Promise<string> {
    await this.run(['plugin', 'update', pluginId, '--scope', 'user'], MUTATION_TIMEOUT_MS);
    return `插件 ${pluginId} 已更新。重启 Claude 会话后生效。`;
  }

  public async refreshMarketplaces(): Promise<string> {
    await this.run(['plugin', 'marketplace', 'update'], MUTATION_TIMEOUT_MS);
    return '插件市场索引已刷新。';
  }

  public async updateAll(): Promise<string> {
    await this.refreshMarketplaces();
    const catalog = await this.loadCatalog();
    if (catalog.installed.length === 0) {
      return '没有需要更新的已安装插件。';
    }
    let updated = 0;
    const failures: string[] = [];
    for (const plugin of catalog.installed) {
      try {
        await this.run(
          ['plugin', 'update', plugin.pluginId, '--scope', 'user'],
          MUTATION_TIMEOUT_MS,
        );
        updated += 1;
      } catch (error) {
        failures.push(`${plugin.name}：${error instanceof Error ? error.message : '更新失败'}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`已更新 ${updated} 个插件；${failures.slice(0, 3).join('；')}`);
    }
    return `已检查并更新 ${updated} 个插件。重启 Claude 会话后生效。`;
  }

  public async addMarketplace(source: string): Promise<string> {
    await this.run(
      ['plugin', 'marketplace', 'add', source, '--scope', 'user'],
      MUTATION_TIMEOUT_MS,
    );
    return `插件市场 ${source} 已添加。`;
  }

  public async removeMarketplace(name: string): Promise<string> {
    await this.run(['plugin', 'marketplace', 'remove', name], MUTATION_TIMEOUT_MS);
    return `插件市场 ${name} 已移除。`;
  }

  public invalidate(): void {
    this.cached = undefined;
  }

  private async loadCatalog(): Promise<ClaudePluginCatalog> {
    let listOutput: string;
    try {
      listOutput = await this.run(['plugin', 'list', '--json', '--available'], LIST_TIMEOUT_MS);
    } catch (error) {
      const catalog = emptyCatalog(
        error instanceof Error ? error.message : '无法读取插件列表。',
        false,
      );
      this.cached = catalog;
      return catalog;
    }

    let plugins: { available: ClaudePluginView[]; installed: ClaudePluginView[] };
    try {
      plugins = parsePluginCatalog(listOutput);
    } catch {
      const catalog = emptyCatalog('Claude 命令行返回了无法解析的插件列表。', true);
      this.cached = catalog;
      return catalog;
    }

    let marketplaces: ClaudePluginMarketplaceView[] = [];
    try {
      marketplaces = parseMarketplaces(
        await this.run(['plugin', 'marketplace', 'list', '--json'], LIST_TIMEOUT_MS),
      );
    } catch {
      // A missing marketplace list must not hide the plugins that were read successfully.
    }

    const catalog: ClaudePluginCatalog = {
      available: plugins.available,
      checkedAt: Date.now(),
      cliAvailable: true,
      installed: plugins.installed,
      marketplaces,
      message: `已安装 ${plugins.installed.length} 个插件，市场中还有 ${plugins.available.length} 个可选。`,
      updatesAvailable: plugins.installed.filter((plugin) => plugin.updateAvailable).length,
    };
    this.cached = catalog;
    return catalog;
  }

  /**
   * Resolves the Windows command shim without interpolating user-controlled arguments into
   * PowerShell source. This supports native executables as well as npm's `.cmd`/`.ps1` shims.
   */
  private async run(argumentsList: string[], timeout: number): Promise<string> {
    try {
      const stdout = await runWindowsCommand('claude', argumentsList, {
        cwd: this.cwd,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout,
      });
      return stdout;
    } catch (error) {
      const record = error as { code?: unknown; killed?: boolean };
      const rawMessage = error instanceof Error ? error.message : '';
      if (
        record.code === 'ENOENT' ||
        /Get-Command.+claude|not recognized|CommandNotFoundException/i.test(rawMessage)
      ) {
        throw new Error('未找到 claude 命令，请先安装 Claude Code 后再管理插件。', {
          cause: error,
        });
      }
      if (record.killed) {
        throw new Error('Claude 插件命令执行超时，请稍后重试。', { cause: error });
      }
      throw new Error('Claude 插件命令执行失败；请确认 Claude Code 已登录并支持插件命令。', {
        cause: error,
      });
    }
  }
}
