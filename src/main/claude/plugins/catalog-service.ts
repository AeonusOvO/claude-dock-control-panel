import { compareCatalogEntries, normalizePluginCatalogSources } from './catalog-normalizer';
import {
  GenerationFencedPresentationCache,
  type PresentationCacheResult,
} from './presentation-cache';
import {
  PLUGIN_CATALOG_LIMITS,
  PluginCatalogValidationError,
  assertOnlyKeys,
  boundedString,
  canonicalPluginId,
  canonicalSourceId,
  createCatalogEntryId,
  exactPluginIdentityKey,
  normalizeComponentInventory,
  normalizeSourceDisplay,
  optionalBoundedString,
  requirePlainRecord,
  type InstalledPluginRecord,
  type PluginCatalogEntry,
  type PluginCatalogSnapshot,
  type PluginCatalogSource,
  type PluginScope,
} from './source-types';

const INSTALLED_KEYS = new Set([
  'canonicalPluginId',
  'canonicalSourceId',
  'components',
  'description',
  'display',
  'enabled',
  'name',
  'scope',
  'sourceRevision',
  'updateAvailable',
  'version',
]);

interface NormalizedInstalledPlugin {
  canonicalPluginId: string;
  canonicalSourceId: string;
  components?: InstalledPluginRecord['components'];
  description?: string;
  display?: InstalledPluginRecord['display'];
  enabled?: boolean;
  name: string;
  scope?: PluginScope;
  sourceRevision?: string;
  updateAvailable?: boolean;
  version?: string;
}

export interface PluginCatalogServiceLoaders {
  loadInstalledPlugins: () =>
    Promise<readonly InstalledPluginRecord[]> | readonly InstalledPluginRecord[];
  loadRecommendationSources: () =>
    Promise<readonly PluginCatalogSource[]> | readonly PluginCatalogSource[];
}

export interface PluginCatalogServiceOptions {
  now?: () => number;
  ttlMs?: number;
}

export type PluginCatalogServiceResult = PresentationCacheResult<PluginCatalogSnapshot>;
export type PluginCatalogPresentationEntry = Omit<PluginCatalogEntry, 'canonicalSourceId'>;

export interface PluginCatalogPresentation {
  checkedAt: number;
  entries: readonly PluginCatalogPresentationEntry[];
  installedCount: number;
  updatesAvailable: number;
}

const scope = (value: unknown): PluginScope | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== 'local' && value !== 'project' && value !== 'user') {
    throw new PluginCatalogValidationError('Installed plugin scope is invalid.');
  }
  return value;
};

const optionalBoolean = (value: unknown, message: string): boolean | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new PluginCatalogValidationError(message);
  }
  return value;
};

const normalizeInstalledPlugin = (value: unknown): NormalizedInstalledPlugin => {
  const record = requirePlainRecord(value, 'Installed plugin record is invalid.');
  assertOnlyKeys(record, INSTALLED_KEYS, 'Installed plugin record contains unsupported fields.');
  return {
    canonicalPluginId: canonicalPluginId(record.canonicalPluginId),
    canonicalSourceId: canonicalSourceId(record.canonicalSourceId),
    components: normalizeComponentInventory(record.components),
    description: optionalBoundedString(
      record.description,
      PLUGIN_CATALOG_LIMITS.descriptionLength,
      'Installed plugin description is invalid.',
    ),
    display: record.display === undefined ? undefined : normalizeSourceDisplay(record.display),
    enabled: optionalBoolean(record.enabled, 'Installed plugin enabled state is invalid.'),
    name: boundedString(record.name, 160, 'Installed plugin name is invalid.'),
    scope: scope(record.scope),
    sourceRevision: optionalBoundedString(
      record.sourceRevision,
      PLUGIN_CATALOG_LIMITS.versionLength,
      'Installed plugin source revision is invalid.',
    ),
    updateAvailable: optionalBoolean(
      record.updateAvailable,
      'Installed plugin update state is invalid.',
    ),
    version: optionalBoundedString(
      record.version,
      PLUGIN_CATALOG_LIMITS.versionLength,
      'Installed plugin version is invalid.',
    ),
  };
};

const installedFingerprint = (plugin: NormalizedInstalledPlugin): string =>
  JSON.stringify([
    plugin.canonicalPluginId,
    plugin.canonicalSourceId,
    plugin.components ?? null,
    plugin.description ?? null,
    plugin.display ?? null,
    plugin.enabled ?? null,
    plugin.name,
    plugin.scope ?? null,
    plugin.sourceRevision ?? null,
    plugin.updateAvailable ?? null,
    plugin.version ?? null,
  ]);

const normalizeInstalledPlugins = (
  values: readonly InstalledPluginRecord[],
): ReadonlyMap<string, NormalizedInstalledPlugin> => {
  if (!Array.isArray(values) || values.length > PLUGIN_CATALOG_LIMITS.entries) {
    throw new PluginCatalogValidationError('Installed plugin collection is invalid.');
  }
  const normalized = new Map<string, { fingerprint: string; plugin: NormalizedInstalledPlugin }>();
  for (const value of values) {
    const plugin = normalizeInstalledPlugin(value);
    const identity = exactPluginIdentityKey(plugin.canonicalSourceId, plugin.canonicalPluginId);
    const fingerprint = installedFingerprint(plugin);
    const existing = normalized.get(identity);
    if (existing && existing.fingerprint !== fingerprint) {
      throw new PluginCatalogValidationError('Installed plugin identity conflicts.');
    }
    if (!existing) {
      normalized.set(identity, { fingerprint, plugin });
    }
  }
  return new Map([...normalized].map(([identity, item]) => [identity, item.plugin]));
};

const hasVersionUpdate = (
  installed: NormalizedInstalledPlugin,
  latestVersion: string | undefined,
  latestRevision: string | undefined,
): boolean =>
  installed.updateAvailable === true ||
  Boolean(installed.version && latestVersion && installed.version !== latestVersion) ||
  Boolean(
    installed.sourceRevision && latestRevision && installed.sourceRevision !== latestRevision,
  );

const mergeKnownEntry = (
  entry: ReturnType<typeof normalizePluginCatalogSources>[number],
  installed: NormalizedInstalledPlugin | undefined,
): PluginCatalogEntry => ({
  ...entry,
  enabled: installed?.enabled,
  installed: installed !== undefined,
  installedSourceRevision: installed?.sourceRevision,
  installedVersion: installed?.version,
  latestSourceRevision: entry.sourceRevision,
  latestVersion: entry.version,
  scope: installed?.scope,
  updateAvailable: installed
    ? hasVersionUpdate(installed, entry.version, entry.sourceRevision)
    : false,
});

const unknownInstalledEntry = (installed: NormalizedInstalledPlugin): PluginCatalogEntry => ({
  canonicalPluginId: installed.canonicalPluginId,
  canonicalSourceId: installed.canonicalSourceId,
  catalogEntryId: createCatalogEntryId(installed.canonicalSourceId, installed.canonicalPluginId),
  components: installed.components,
  description: installed.description,
  displaySource: installed.display ?? { label: 'Unknown plugin source' },
  enabled: installed.enabled,
  executionPreviewRequired: false,
  installCapability: 'unavailable',
  installKind: 'none',
  installed: true,
  installedSourceRevision: installed.sourceRevision,
  installedVersion: installed.version,
  name: installed.name,
  publisherId: 'unknown',
  publisherLabel: 'Unknown publisher',
  recommendationTier: 'none',
  scope: installed.scope,
  sourceKind: 'unknown',
  updateAvailable: installed.updateAvailable === true,
});

const assertUniquePresentationIds = (entries: readonly PluginCatalogEntry[]): void => {
  const identities = new Map<string, string>();
  for (const entry of entries) {
    const identity = exactPluginIdentityKey(entry.canonicalSourceId, entry.canonicalPluginId);
    const existing = identities.get(entry.catalogEntryId);
    if (existing && existing !== identity) {
      throw new PluginCatalogValidationError('Plugin catalog presentation identity conflicts.');
    }
    identities.set(entry.catalogEntryId, identity);
  }
};

/** Merges state only by exact canonical source plus canonical plugin identity. */
export const buildPluginCatalogSnapshot = (
  sources: readonly PluginCatalogSource[],
  installedValues: readonly InstalledPluginRecord[],
  checkedAt = Date.now(),
): PluginCatalogSnapshot => {
  const normalizedSources = normalizePluginCatalogSources(sources);
  const installed = normalizeInstalledPlugins(installedValues);
  const knownIdentities = new Set<string>();
  const entries: PluginCatalogEntry[] = normalizedSources.map((entry) => {
    const identity = exactPluginIdentityKey(entry.canonicalSourceId, entry.canonicalPluginId);
    knownIdentities.add(identity);
    return mergeKnownEntry(entry, installed.get(identity));
  });
  for (const [identity, plugin] of installed) {
    if (!knownIdentities.has(identity)) {
      entries.push(unknownInstalledEntry(plugin));
    }
  }
  assertUniquePresentationIds(entries);
  entries.sort(compareCatalogEntries);
  return {
    checkedAt,
    entries,
    installedCount: entries.filter((entry) => entry.installed).length,
    updatesAvailable: entries.filter((entry) => entry.updateAvailable).length,
  };
};

/** Drops main-only exact source identity after all display fields have been sanitized. */
export const projectPluginCatalogPresentation = (
  snapshot: PluginCatalogSnapshot,
): PluginCatalogPresentation => ({
  checkedAt: snapshot.checkedAt,
  entries: snapshot.entries.map((entry) => {
    const { canonicalSourceId: mainOnlySourceIdentity, ...presentation } = entry;
    void mainOnlySourceIdentity;
    return presentation;
  }),
  installedCount: snapshot.installedCount,
  updatesAvailable: snapshot.updatesAvailable,
});

export class PluginCatalogService {
  private readonly cache: GenerationFencedPresentationCache<PluginCatalogSnapshot>;
  private readonly now: () => number;

  public constructor(
    private readonly loaders: PluginCatalogServiceLoaders,
    options: PluginCatalogServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cache = new GenerationFencedPresentationCache<PluginCatalogSnapshot>({
      createFallback: () => ({
        checkedAt: this.now(),
        entries: [],
        installedCount: 0,
        updatesAvailable: 0,
      }),
      failureMessage: 'Plugin catalog refresh failed; showing last-known-good data.',
      now: this.now,
      ttlMs: options.ttlMs ?? 10_000,
    });
  }

  public getCatalog(force = false): Promise<PluginCatalogServiceResult> {
    return this.cache.get(async () => {
      const [sources, installed] = await Promise.all([
        this.loaders.loadRecommendationSources(),
        this.loaders.loadInstalledPlugins(),
      ]);
      return buildPluginCatalogSnapshot(sources, installed, this.now());
    }, force);
  }

  public invalidate(): void {
    this.cache.invalidate();
  }
}
