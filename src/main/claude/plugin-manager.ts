import path from 'node:path';
import type {
  ClaudePluginCatalog,
  ClaudePluginGitHubMetadata,
  ClaudePluginMarketplaceView,
  ClaudePluginOperationKind,
  ClaudePluginOperationView,
  ClaudePluginScope,
  ClaudePluginView,
} from '../../shared/contracts';
import { runWindowsCommand } from '../infra/windows-command';
import {
  normalizeGitHubRepositoryIdentity,
  type GitHubRepositoryIdentity,
} from './plugins/source-types';
import { GitHubRepositoryStarsService } from './plugins/github-repository-service';

const LIST_TIMEOUT_MS = 120_000;
const MUTATION_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_PLUGINS = 2_048;
const MAX_MARKETPLACES = 256;
const MAX_CATALOG_ENTRIES = 10_000;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_SOURCE_LABEL_LENGTH = 1_024;
const MAX_INSTALL_LOCATION_LENGTH = 4_096;
const MAX_MARKETPLACE_SOURCE_LENGTH = 400;
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * `plugin@marketplace` as printed by `claude plugin list --json --available`. Both halves are
 * restricted so the identifier can never be read as an option or a shell fragment.
 */
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$/;
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const isValidPluginId = (value: unknown): value is string =>
  typeof value === 'string' && PLUGIN_ID.test(value);

export const isValidMarketplaceName = (value: unknown): value is string =>
  typeof value === 'string' && MARKETPLACE_NAME.test(value);

const hasAmbiguousPathSegment = (value: string): boolean =>
  value.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');

const isSafeLocalMarketplaceSource = (value: string): boolean => {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const pathFromRoot = value.slice(2);
    return (
      !/[\\/]{2}/.test(pathFromRoot) &&
      !/[<>:"|?*]/.test(value.slice(3)) &&
      !hasAmbiguousPathSegment(value)
    );
  }
  if (!value.startsWith('\\\\') || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) {
    return false;
  }
  if (value.includes('/')) {
    return false;
  }
  const segments = value.slice(2).replace(/\\$/, '').split('\\');
  return (
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        Boolean(segment) && segment !== '.' && segment !== '..' && !/[<>:"|?*]/.test(segment),
    )
  );
};

/**
 * A marketplace source may be a GitHub `owner/repo`, a credential-free https URL or an absolute
 * local drive/UNC path. Ambiguous URL spellings, device paths and control characters are refused.
 */
export const isValidMarketplaceSource = (value: unknown): value is string => {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MARKETPLACE_SOURCE_LENGTH || trimmed.startsWith('-')) {
    return false;
  }
  if (GITHUB_SHORTHAND.test(trimmed)) {
    return true;
  }
  if (isSafeLocalMarketplaceSource(trimmed)) {
    return true;
  }
  if (!/^https:\/\//i.test(trimmed) || trimmed.includes('\\')) {
    return false;
  }
  const authority = trimmed.slice('https://'.length).split(/[/?#]/, 1)[0];
  if (!authority || authority.includes('@')) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
};

const optionalString = (
  value: unknown,
  maximumLength = MAX_SOURCE_LABEL_LENGTH,
): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximumLength ? trimmed : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizedGitHubIdentity = (value: unknown): GitHubRepositoryIdentity | undefined => {
  try {
    return normalizeGitHubRepositoryIdentity(value);
  } catch {
    return undefined;
  }
};

/** Extracts only the repository identity already present in the CLI's structured source field. */
const githubIdentityFromSource = (value: unknown): GitHubRepositoryIdentity | undefined => {
  const candidates = isRecord(value) ? [value.url, value.source] : [value];
  for (const candidate of candidates) {
    const identity = normalizedGitHubIdentity(candidate);
    if (identity) {
      return identity;
    }
    // Marketplace records sometimes omit the scheme while retaining the www host. Normalize that
    // display spelling through the shared identity helper rather than trusting it as a URI.
    if (typeof candidate === 'string' && /^(?:www\.)?github\.com\//i.test(candidate)) {
      const hostIdentity = normalizedGitHubIdentity(`https://${candidate}`);
      if (hostIdentity) {
        return hostIdentity;
      }
    }
  }
  return undefined;
};

const builtInGitHubMetadata = (identity: GitHubRepositoryIdentity): ClaudePluginGitHubMetadata => ({
  provenance: 'built-in',
  repositoryUri: identity.uri,
  stars: null,
});

const githubMetadataFromSource = (value: unknown): ClaudePluginGitHubMetadata | undefined => {
  const identity = githubIdentityFromSource(value);
  return identity ? builtInGitHubMetadata(identity) : undefined;
};

const optionalCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const scopeOf = (value: unknown): ClaudePluginScope | undefined =>
  value === 'local' || value === 'project' || value === 'user' ? value : undefined;

export const UNKNOWN_PLUGIN_SOURCE = '未知来源';

const safeHttpsSourceLabel = (value: unknown): string | undefined => {
  const source = optionalString(value, MAX_MARKETPLACE_SOURCE_LENGTH);
  if (
    !source ||
    CONTROL_CHARACTER.test(source) ||
    !/^https:\/\//i.test(source) ||
    source.includes('\\')
  ) {
    return undefined;
  }
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || !url.hostname) {
      return undefined;
    }
    const pathname = url.pathname.replace(/\.git$/i, '').replace(/^\/+/, '');
    return /^(?:www\.)?github\.com$/i.test(url.hostname)
      ? pathname
      : [url.hostname, pathname].filter(Boolean).join('/');
  } catch {
    return undefined;
  }
};

const safeRelativeSourceLabel = (
  value: unknown,
  maximumLength = MAX_SOURCE_LABEL_LENGTH,
): string | undefined => {
  const source = optionalString(value, maximumLength);
  if (
    !source ||
    CONTROL_CHARACTER.test(source) ||
    path.isAbsolute(source) ||
    /^[A-Za-z]:[\\/]/.test(source) ||
    source.startsWith('\\\\') ||
    source.includes('?') ||
    source.includes('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/i.test(source) ||
    source.includes('://')
  ) {
    return undefined;
  }
  const normalized = source.replace(/^\.[\\/]/, '');
  if (!normalized || hasAmbiguousPathSegment(normalized)) {
    return undefined;
  }
  return normalized.replaceAll('\\', '/');
};

const safeSourceLabel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  return /^https:\/\//i.test(value) ? safeHttpsSourceLabel(value) : safeRelativeSourceLabel(value);
};

/** The CLI prints `source` either as a bare relative path or as a git descriptor object. */
export const describePluginSource = (value: unknown): string => {
  if (typeof value === 'string') {
    return safeSourceLabel(value) ?? UNKNOWN_PLUGIN_SOURCE;
  }
  if (!isRecord(value)) {
    return UNKNOWN_PLUGIN_SOURCE;
  }
  const label = safeHttpsSourceLabel(value.url) ?? safeSourceLabel(value.source);
  const subPath = safeRelativeSourceLabel(value.path, 512);
  const ref = safeRelativeSourceLabel(value.ref, 160);
  return [label ?? UNKNOWN_PLUGIN_SOURCE, subPath, ref && `@${ref}`].filter(Boolean).join(' · ');
};

/** Installed entries report `"unknown"` when the marketplace ships no version of its own. */
const optionalVersion = (value: unknown): string | undefined => {
  const version = optionalString(value, 160);
  return version && version.toLowerCase() !== 'unknown' ? version : undefined;
};

export const MISSING_PLUGIN_DESCRIPTION = '这个插件没有提供说明。';

export const parsePluginEntry = (value: unknown, installed: boolean): ClaudePluginView | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sourceRecord =
    record.source && typeof record.source === 'object'
      ? (record.source as Record<string, unknown>)
      : undefined;
  const declaredName = optionalString(record.name, 80);
  const declaredMarketplace = optionalString(record.marketplaceName, 80) ?? '';
  /*
   * `claude plugin list --json --available` describes available plugins with
   * `pluginId`/`name`/`marketplaceName`, but installed plugins only with `id`
   * (`plugin@marketplace`). Accepting `id` and splitting it keeps installed plugins visible.
   */
  const pluginId =
    optionalString(record.pluginId, 161) ??
    optionalString(record.id, 161) ??
    (declaredName && declaredMarketplace ? `${declaredName}@${declaredMarketplace}` : declaredName);
  if (!pluginId || !isValidPluginId(pluginId)) {
    return null;
  }
  const [idName, idMarketplace] = pluginId.split('@');
  const name = declaredName && MARKETPLACE_NAME.test(declaredName) ? declaredName : idName;
  if (!name) {
    return null;
  }

  return {
    description:
      optionalString(record.description, MAX_DESCRIPTION_LENGTH) ?? MISSING_PLUGIN_DESCRIPTION,
    // The CLI omits `enabled` for available plugins and for enabled installs alike.
    enabled: installed ? record.enabled !== false : false,
    github: githubMetadataFromSource(record.source),
    installCount: optionalCount(record.installCount),
    installed,
    marketplaceName:
      (declaredMarketplace && MARKETPLACE_NAME.test(declaredMarketplace) && declaredMarketplace) ||
      idMarketplace ||
      '本地',
    name,
    pluginId,
    scope: scopeOf(record.scope),
    sourceLabel: describePluginSource(record.source),
    sourceRevision: optionalString(sourceRecord?.sha, 160),
    latestVersion: optionalVersion(record.latestVersion),
    updateAvailable: record.updateAvailable === true,
    version: optionalVersion(record.version),
  };
};

export const parsePluginCatalog = (
  raw: string,
): { available: ClaudePluginView[]; installed: ClaudePluginView[] } => {
  const parsed: unknown = JSON.parse(raw);
  const collect = (value: unknown, installed: boolean): ClaudePluginView[] =>
    Array.isArray(value)
      ? value
          .slice(0, MAX_CATALOG_ENTRIES)
          .map((entry) => parsePluginEntry(entry, installed))
          .filter((entry): entry is ClaudePluginView => entry !== null)
      : [];

  if (Array.isArray(parsed)) {
    const installed = collect(parsed, true);
    if (parsed.length > 0 && installed.length === 0) {
      throw new Error('Unexpected plugin catalog entries.');
    }
    return { available: [], installed };
  }
  if (!isRecord(parsed)) {
    throw new Error('Unexpected plugin catalog shape.');
  }

  const record = parsed;
  if (
    (record.available !== undefined && !Array.isArray(record.available)) ||
    (record.installed !== undefined && !Array.isArray(record.installed)) ||
    (!Array.isArray(record.available) && !Array.isArray(record.installed))
  ) {
    throw new Error('Unexpected plugin catalog shape.');
  }
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
      github: plugin.github ?? latest?.github,
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
  const inputEntryCount =
    (Array.isArray(record.available) ? record.available.length : 0) +
    (Array.isArray(record.installed) ? record.installed.length : 0);
  if (inputEntryCount > 0 && availableCatalog.length + installed.length === 0) {
    throw new Error('Unexpected plugin catalog entries.');
  }
  const installedIds = new Set(installed.map((plugin) => plugin.pluginId));
  const available = availableCatalog.filter((plugin) => !installedIds.has(plugin.pluginId));
  return { available, installed };
};

const safeRepositoryLabel = (value: unknown): string | undefined => {
  const source = optionalString(value, MAX_MARKETPLACE_SOURCE_LENGTH);
  if (!source || CONTROL_CHARACTER.test(source)) {
    return undefined;
  }
  if (GITHUB_SHORTHAND.test(source)) {
    return source;
  }
  if (!/^https:\/\//i.test(source) || source.includes('\\')) {
    return undefined;
  }
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return undefined;
    }
    return `${url.hostname}${url.pathname.replace(/\.git$/i, '')}`;
  } catch {
    return undefined;
  }
};

const safeMarketplaceSourceLabel = (value: unknown): string => {
  const source = optionalString(value, MAX_MARKETPLACE_SOURCE_LENGTH);
  if (!source || CONTROL_CHARACTER.test(source)) {
    return '未知';
  }
  if (isSafeLocalMarketplaceSource(source) || path.isAbsolute(source)) {
    return '本地';
  }
  return safeSourceLabel(source) ?? '未知';
};

export const parseMarketplaces = (raw: string): ClaudePluginMarketplaceView[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const marketplaces: ClaudePluginMarketplaceView[] = [];
  for (const entry of parsed.slice(0, MAX_MARKETPLACES)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = optionalString(record.name, 80);
    if (!name || !isValidMarketplaceName(name)) {
      continue;
    }
    marketplaces.push({
      // This remains in the existing renderer contract until the later contract-hardening phase.
      installLocation: optionalString(record.installLocation, MAX_INSTALL_LOCATION_LENGTH),
      name,
      repo: safeRepositoryLabel(record.repo),
      source: safeMarketplaceSourceLabel(record.source),
    });
  }
  return marketplaces;
};

/** What a marketplace manifest knows about a plugin that `plugin list` omits for installs. */
export interface PluginManifestEntry {
  description?: string;
  sourceLabel?: string;
}

const isContainedPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
};

const unsafeManifestError = (): Error => new Error('插件市场清单不可用。');

/**
 * Node does not expose a handle-relative "open beneath this directory without reparse points" API on
 * Windows. A check-then-open implementation can be redirected through a junction between checks, so
 * production manifest enrichment fails closed instead of reading a CLI-provided absolute path. The
 * caller retains the CLI catalog entry when this generic, path-free error is returned.
 */
export const readBoundedMarketplaceManifest = (
  installationDirectory: string,
  candidatePath: string,
): Promise<string> => {
  if (!path.isAbsolute(installationDirectory) || !path.isAbsolute(candidatePath)) {
    return Promise.reject(unsafeManifestError());
  }
  const lexicalRoot = path.resolve(installationDirectory);
  const lexicalCandidate = path.resolve(candidatePath);
  if (lexicalCandidate === lexicalRoot || !isContainedPath(lexicalRoot, lexicalCandidate)) {
    return Promise.reject(unsafeManifestError());
  }

  // Never cross the unsafe Node filesystem seam, even when lexical containment happens to hold.
  return Promise.reject(unsafeManifestError());
};

export const readMarketplaceManifest = (installLocation: string): Promise<string> =>
  readBoundedMarketplaceManifest(
    installLocation,
    path.resolve(installLocation, '.claude-plugin', 'marketplace.json'),
  );

const manifestSource = (value: unknown): string | undefined => {
  const source = optionalString(value, 512);
  if (!source || CONTROL_CHARACTER.test(source) || path.isAbsolute(source)) {
    return undefined;
  }
  const relativeSource = source.replace(/^\.[\\/]/, '');
  if (!relativeSource || hasAmbiguousPathSegment(relativeSource)) {
    return undefined;
  }
  return relativeSource.replaceAll('\\', '/');
};

/**
 * Parses bounded marketplace manifests supplied through the reader seam and keys their plugins by
 * `plugin@marketplace`. The production reader currently fails closed on the unsafe Windows filesystem
 * seam; an unavailable manifest only omits enrichment and never removes CLI catalog entries.
 */
export const collectMarketplaceManifests = async (
  marketplaces: ClaudePluginMarketplaceView[],
  readManifest: (installLocation: string) => Promise<string> | string = readMarketplaceManifest,
): Promise<Map<string, PluginManifestEntry>> => {
  const manifests = new Map<string, PluginManifestEntry>();
  for (const marketplace of marketplaces.slice(0, MAX_MARKETPLACES)) {
    if (!marketplace.installLocation || !isValidMarketplaceName(marketplace.name)) {
      continue;
    }
    let parsed: unknown;
    try {
      const manifestText = await readManifest(marketplace.installLocation);
      if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
        continue;
      }
      parsed = JSON.parse(manifestText);
    } catch {
      // A missing, unsafe or malformed manifest only costs descriptions, never the plugin list.
      continue;
    }
    const plugins = isRecord(parsed) ? parsed.plugins : undefined;
    if (!Array.isArray(plugins)) {
      continue;
    }
    for (const entry of plugins.slice(0, MAX_MANIFEST_PLUGINS)) {
      if (!isRecord(entry)) {
        continue;
      }
      const name = optionalString(entry.name, 80);
      if (!name || !MARKETPLACE_NAME.test(name)) {
        continue;
      }
      const subPath = manifestSource(entry.source);
      const description = optionalString(entry.description, MAX_DESCRIPTION_LENGTH);
      manifests.set(`${name}@${marketplace.name}`, {
        description,
        sourceLabel: [marketplace.repo ?? marketplace.name, subPath].filter(Boolean).join(' · '),
      });
    }
  }
  return manifests;
};

/** Fills in the description and source the CLI omits for installed plugins. */
export const enrichInstalledPlugins = (
  installed: ClaudePluginView[],
  manifests: Map<string, PluginManifestEntry>,
): ClaudePluginView[] =>
  installed.map((plugin) => {
    const manifest = manifests.get(plugin.pluginId);
    if (!manifest) {
      return plugin;
    }
    return {
      ...plugin,
      description:
        plugin.description === MISSING_PLUGIN_DESCRIPTION && manifest.description
          ? manifest.description
          : plugin.description,
      sourceLabel:
        plugin.sourceLabel === UNKNOWN_PLUGIN_SOURCE && manifest.sourceLabel
          ? manifest.sourceLabel
          : plugin.sourceLabel,
    };
  });

/** Supplies repository identity from the existing marketplace record without trusting its label. */
export const enrichPluginRepositoryMetadata = (
  plugins: ClaudePluginView[],
  marketplaces: ClaudePluginMarketplaceView[],
): ClaudePluginView[] => {
  const repositoriesByMarketplace = new Map<string, ClaudePluginGitHubMetadata>();
  for (const marketplace of marketplaces) {
    const identity = githubIdentityFromSource(marketplace.repo);
    if (identity) {
      repositoriesByMarketplace.set(marketplace.name, builtInGitHubMetadata(identity));
    }
  }
  return plugins.map((plugin) =>
    plugin.github || !repositoriesByMarketplace.has(plugin.marketplaceName)
      ? plugin
      : {
          ...plugin,
          github: repositoriesByMarketplace.get(plugin.marketplaceName),
        },
  );
};

export interface ClaudePluginGitHubMetadataService {
  get: (value: unknown) => Promise<ClaudePluginGitHubMetadata | undefined>;
}

const emptyCatalog = (message: string, cliAvailable: boolean): ClaudePluginCatalog => ({
  available: [],
  checkedAt: Date.now(),
  cliAvailable,
  installed: [],
  marketplaces: [],
  message,
  updatesAvailable: 0,
});

class PluginCatalogLoadError extends Error {
  public constructor(
    message: string,
    public readonly cliAvailable: boolean,
  ) {
    super(message);
  }
}

interface CatalogLoad {
  generation: number;
  promise: Promise<ClaudePluginCatalog>;
}

export type ClaudePluginMutationRequest =
  | { pluginId: string; type: 'install' }
  | { pluginId: string; type: 'uninstall' }
  | { enabled: boolean; pluginId: string; type: 'set-enabled' }
  | { pluginId: string; type: 'update' }
  | { type: 'marketplaces-refresh' }
  | { type: 'update-all' }
  | { source: string; type: 'marketplace-add' }
  | { name: string; type: 'marketplace-remove' };

interface ActivePluginMutation {
  identity: string;
  operation: ClaudePluginOperationView;
  promise: Promise<ClaudePluginMutationOutcome>;
}

export const claudePluginMutationIdentity = (request: ClaudePluginMutationRequest): string => {
  switch (request.type) {
    case 'install':
    case 'uninstall':
    case 'update':
      return `${request.type}:${request.pluginId}`;
    case 'set-enabled':
      return `${request.type}:${request.pluginId}:${request.enabled}`;
    case 'marketplace-add':
      return `${request.type}:${request.source.trim()}`;
    case 'marketplace-remove':
      return `${request.type}:${request.name}`;
    case 'marketplaces-refresh':
    case 'update-all':
      return request.type;
  }
};

const pluginMutationOperation = (
  request: ClaudePluginMutationRequest,
  attempt: number,
): ClaudePluginOperationView => {
  let kind: ClaudePluginOperationKind;
  let target: string;
  switch (request.type) {
    case 'install':
    case 'uninstall':
    case 'update':
      kind = request.type;
      target = request.pluginId;
      break;
    case 'set-enabled':
      kind = request.enabled ? 'enable' : 'disable';
      target = request.pluginId;
      break;
    case 'marketplace-add':
      kind = 'marketplace-add';
      target = '插件市场';
      break;
    case 'marketplace-remove':
      kind = 'marketplace-remove';
      target = request.name;
      break;
    case 'marketplaces-refresh':
      kind = 'refresh';
      target = '插件市场';
      break;
    case 'update-all':
      kind = 'update-all';
      target = '所有插件';
      break;
  }
  return Object.freeze({ attempt, kind, phase: 'mutating', startedAt: Date.now(), target });
};

const withoutActivePluginOperation = (catalog: ClaudePluginCatalog): ClaudePluginCatalog => {
  if (catalog.activeOperation === undefined) {
    return catalog;
  }
  const settled = { ...catalog };
  delete settled.activeOperation;
  return settled;
};

export interface ClaudePluginMutationOutcome {
  catalog: ClaudePluginCatalog;
  message: string;
}

export class ClaudePluginMutationError extends Error {
  public constructor(
    message: string,
    public readonly catalog: ClaudePluginCatalog,
  ) {
    super(message);
  }
}

export class ClaudePluginManager {
  private activeMutation?: ActivePluginMutation;
  private cached?: ClaudePluginCatalog;
  private cacheCurrent = false;
  private catalogGeneration = 0;
  private inFlight?: CatalogLoad;
  private lastGood?: ClaudePluginCatalog;
  private nextMutationAttempt = 1;

  public constructor(
    private readonly cwd: string,
    private readonly commandRunner: typeof runWindowsCommand = runWindowsCommand,
    private readonly manifestReader: (
      installLocation: string,
    ) => Promise<string> | string = readMarketplaceManifest,
    private readonly githubMetadataService: ClaudePluginGitHubMetadataService = new GitHubRepositoryStarsService(),
  ) {}

  /** Returns a stable snapshot immediately, including any application-global mutation owner. */
  public getCatalog(refresh = false): Promise<ClaudePluginCatalog> {
    return this.readCatalog(refresh, false);
  }

  public hasActiveMutation(): boolean {
    return this.activeMutation !== undefined;
  }

  /** Joins an identical in-flight mutation and rejects every competing side effect. */
  public mutate(request: ClaudePluginMutationRequest): Promise<ClaudePluginMutationOutcome> {
    const identity = claudePluginMutationIdentity(request);
    if (this.activeMutation) {
      if (this.activeMutation.identity === identity) {
        return this.activeMutation.promise;
      }
      return Promise.reject(
        new ClaudePluginMutationError(
          '已有插件操作正在进行，请等待完成后再试。',
          this.catalogForView(
            this.cached ?? this.lastGood ?? emptyCatalog('插件操作正在进行。', true),
          ),
        ),
      );
    }

    const attempt = this.nextMutationAttempt++;
    const operation = pluginMutationOperation(request, attempt);
    const run = Promise.resolve().then(() => this.performMutation(request, attempt));
    const completion = run.finally(() => {
      if (this.activeMutation?.operation.attempt === attempt) {
        this.activeMutation = undefined;
      }
    });
    this.activeMutation = { identity, operation, promise: completion };
    return completion;
  }

  /** Supersedes current reads without discarding the last-known-good fallback. */
  public invalidate(): void {
    this.catalogGeneration += 1;
    this.cacheCurrent = false;
    this.inFlight = undefined;
  }

  private catalogForView(catalog: ClaudePluginCatalog): ClaudePluginCatalog {
    const settled = withoutActivePluginOperation(catalog);
    return this.activeMutation
      ? { ...settled, activeOperation: this.activeMutation.operation }
      : settled;
  }

  private async catalogAfterMutation(active: ActivePluginMutation): Promise<ClaudePluginCatalog> {
    try {
      return (await active.promise).catalog;
    } catch (error) {
      if (error instanceof ClaudePluginMutationError) {
        return error.catalog;
      }
      return this.readCatalog(false, false);
    }
  }

  private async performMutation(
    request: ClaudePluginMutationRequest,
    attempt: number,
  ): Promise<ClaudePluginMutationOutcome> {
    let message: string | undefined;
    let mutationError: unknown;
    try {
      message = await this.executeMutation(request);
    } catch (error) {
      mutationError = error;
    }

    // Even a failed CLI command may have applied part of a mutation, so every attempt fences reads.
    if (this.activeMutation?.operation.attempt === attempt) {
      this.activeMutation.operation = Object.freeze({
        ...this.activeMutation.operation,
        phase: 'refreshing',
      });
    }
    this.invalidate();
    const catalog = withoutActivePluginOperation(await this.readCatalog(true, true));
    if (mutationError !== undefined) {
      throw new ClaudePluginMutationError(
        mutationError instanceof Error ? mutationError.message : '插件操作失败。',
        catalog,
      );
    }
    return { catalog, message: message ?? '插件操作已完成。' };
  }

  private async readCatalog(
    refresh: boolean,
    mutationOwnedRefresh: boolean,
  ): Promise<ClaudePluginCatalog> {
    if (this.activeMutation && !mutationOwnedRefresh) {
      return this.catalogForView(
        this.cached ?? this.lastGood ?? emptyCatalog('插件操作正在进行。', true),
      );
    }
    if (!refresh && this.cacheCurrent && this.cached) {
      const catalog = await this.withGitHubMetadata(this.cached);
      this.cached = catalog;
      this.lastGood = catalog;
      return this.catalogForView(catalog);
    }

    const generation = this.catalogGeneration;
    let load = this.inFlight;
    if (!load || load.generation !== generation) {
      load = { generation, promise: this.loadCatalog() };
      this.inFlight = load;
    }

    try {
      const loadedCatalog = await load.promise;
      if (generation !== this.catalogGeneration) {
        const active = this.activeMutation;
        return active ? this.catalogAfterMutation(active) : this.readCatalog(false, false);
      }
      const catalog = await this.withGitHubMetadata(loadedCatalog);
      this.cached = catalog;
      this.lastGood = catalog;
      this.cacheCurrent = true;
      return this.catalogForView(catalog);
    } catch (error) {
      if (generation !== this.catalogGeneration) {
        const active = this.activeMutation;
        return active ? this.catalogAfterMutation(active) : this.readCatalog(false, false);
      }
      const failure =
        error instanceof PluginCatalogLoadError
          ? error
          : new PluginCatalogLoadError('无法读取插件列表。', false);
      if (this.lastGood) {
        this.cached = this.lastGood;
        this.cacheCurrent = true;
        const catalog = await this.withGitHubMetadata({
          ...this.lastGood,
          checkedAt: Date.now(),
          cliAvailable: failure.cliAvailable,
          message: failure.message,
        });
        // Keep the legacy last-known-good snapshot as the process cache. The degraded presentation
        // is returned only for this refresh, so a subsequent cached read retains its old identity.
        return this.catalogForView(catalog);
      }
      return this.catalogForView(emptyCatalog(failure.message, failure.cliAvailable));
    } finally {
      if (this.inFlight === load) {
        this.inFlight = undefined;
      }
    }
  }

  private async withGitHubMetadata(catalog: ClaudePluginCatalog): Promise<ClaudePluginCatalog> {
    const repositories = new Map<string, string>();
    for (const plugin of [...catalog.installed, ...catalog.available]) {
      const identity = plugin.github
        ? normalizedGitHubIdentity(plugin.github.repositoryUri)
        : undefined;
      if (identity) {
        repositories.set(identity.repositoryIdentity, identity.uri);
      }
    }
    if (repositories.size === 0) {
      return catalog;
    }

    const metadataByRepository = new Map<string, ClaudePluginGitHubMetadata>();
    await Promise.all(
      [...repositories].map(async ([repositoryIdentity, repositoryUri]) => {
        try {
          const candidate = await this.githubMetadataService.get(repositoryUri);
          if (!candidate) {
            return;
          }
          const identity = normalizedGitHubIdentity(candidate.repositoryUri);
          const validStars =
            candidate.stars === null ||
            (Number.isSafeInteger(candidate.stars) && candidate.stars >= 0);
          const validProvenance =
            candidate.provenance === 'live' ||
            candidate.provenance === 'cached' ||
            candidate.provenance === 'built-in';
          if (
            !identity ||
            identity.repositoryIdentity !== repositoryIdentity ||
            candidate.repositoryUri !== identity.uri ||
            !validStars ||
            !validProvenance
          ) {
            return;
          }
          metadataByRepository.set(repositoryIdentity, candidate);
        } catch {
          // Repository metadata is display-only; a failed lookup never fails the plugin catalog.
        }
      }),
    );

    let changed = false;
    const decorate = (plugin: ClaudePluginView): ClaudePluginView => {
      if (!plugin.github) {
        return plugin;
      }
      const identity = normalizedGitHubIdentity(plugin.github.repositoryUri);
      const metadata = identity ? metadataByRepository.get(identity.repositoryIdentity) : undefined;
      if (
        !metadata ||
        (metadata.stars === plugin.github.stars &&
          metadata.provenance === plugin.github.provenance &&
          metadata.repositoryUri === plugin.github.repositoryUri)
      ) {
        return plugin;
      }
      changed = true;
      return { ...plugin, github: metadata };
    };
    const installed = catalog.installed.map(decorate);
    const available = catalog.available.map(decorate);
    return changed ? { ...catalog, available, installed } : catalog;
  }

  private assertPluginId(pluginId: string): void {
    if (!isValidPluginId(pluginId)) {
      throw new Error('插件标识无效。');
    }
  }

  private async executeMutation(request: ClaudePluginMutationRequest): Promise<string> {
    switch (request.type) {
      case 'install':
        this.assertPluginId(request.pluginId);
        await this.run(
          ['plugin', 'install', request.pluginId, '--scope', 'user'],
          MUTATION_TIMEOUT_MS,
        );
        return `插件 ${request.pluginId} 已安装。重启 Claude 会话后生效。`;
      case 'uninstall':
        this.assertPluginId(request.pluginId);
        await this.run(
          ['plugin', 'uninstall', request.pluginId, '--scope', 'user', '--yes'],
          MUTATION_TIMEOUT_MS,
        );
        return `插件 ${request.pluginId} 已卸载。`;
      case 'set-enabled':
        this.assertPluginId(request.pluginId);
        await this.run(
          ['plugin', request.enabled ? 'enable' : 'disable', request.pluginId, '--scope', 'user'],
          MUTATION_TIMEOUT_MS,
        );
        return `插件 ${request.pluginId} 已${request.enabled ? '启用' : '停用'}。重启 Claude 会话后生效。`;
      case 'update':
        this.assertPluginId(request.pluginId);
        await this.run(
          ['plugin', 'update', request.pluginId, '--scope', 'user'],
          MUTATION_TIMEOUT_MS,
        );
        return `插件 ${request.pluginId} 已更新。重启 Claude 会话后生效。`;
      case 'marketplaces-refresh':
        await this.run(['plugin', 'marketplace', 'update'], MUTATION_TIMEOUT_MS);
        return '插件市场索引已刷新。';
      case 'update-all':
        return this.updateAllPlugins();
      case 'marketplace-add': {
        if (!isValidMarketplaceSource(request.source)) {
          throw new Error('插件市场地址无效。');
        }
        const source = request.source.trim();
        await this.run(
          ['plugin', 'marketplace', 'add', source, '--scope', 'user'],
          MUTATION_TIMEOUT_MS,
        );
        return '插件市场已添加。';
      }
      case 'marketplace-remove':
        if (!isValidMarketplaceName(request.name)) {
          throw new Error('插件市场名称无效。');
        }
        await this.run(['plugin', 'marketplace', 'remove', request.name], MUTATION_TIMEOUT_MS);
        return `插件市场 ${request.name} 已移除。`;
    }
  }

  private async updateAllPlugins(): Promise<string> {
    await this.run(['plugin', 'marketplace', 'update'], MUTATION_TIMEOUT_MS);
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

  private async loadCatalog(): Promise<ClaudePluginCatalog> {
    let listOutput: string;
    try {
      listOutput = await this.run(['plugin', 'list', '--json', '--available'], LIST_TIMEOUT_MS);
    } catch (error) {
      throw new PluginCatalogLoadError(
        error instanceof Error ? error.message : '无法读取插件列表。',
        false,
      );
    }

    let plugins: { available: ClaudePluginView[]; installed: ClaudePluginView[] };
    try {
      plugins = parsePluginCatalog(listOutput);
    } catch {
      throw new PluginCatalogLoadError('Claude 命令行返回了无法解析的插件列表。', true);
    }

    let marketplaces: ClaudePluginMarketplaceView[] = [];
    try {
      marketplaces = parseMarketplaces(
        await this.run(['plugin', 'marketplace', 'list', '--json'], LIST_TIMEOUT_MS),
      );
    } catch {
      // A missing marketplace list must not hide the plugins that were read successfully.
    }

    const available = enrichPluginRepositoryMetadata(plugins.available, marketplaces);
    const installed = enrichPluginRepositoryMetadata(
      enrichInstalledPlugins(
        plugins.installed,
        await collectMarketplaceManifests(marketplaces, this.manifestReader),
      ),
      marketplaces,
    );

    return {
      available,
      checkedAt: Date.now(),
      cliAvailable: true,
      installed,
      marketplaces,
      message: `已安装 ${installed.length} 个插件，市场中还有 ${available.length} 个可选。`,
      updatesAvailable: installed.filter((plugin) => plugin.updateAvailable).length,
    };
  }

  /**
   * Resolves the Windows command shim without interpolating user-controlled arguments into
   * PowerShell source. This supports native executables as well as npm's `.cmd`/`.ps1` shims.
   */
  private async run(argumentsList: string[], timeout: number): Promise<string> {
    try {
      return await this.commandRunner('claude', argumentsList, {
        cwd: this.cwd,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout,
      });
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
