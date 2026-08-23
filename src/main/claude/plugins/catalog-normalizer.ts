import { OFFICIAL_PLUGIN_SOURCE_ALLOWLIST } from './official-source';
import { recommendPlugin } from './recommendation-policy';
import {
  PLUGIN_CATALOG_LIMITS,
  PluginCatalogValidationError,
  assertOnlyKeys,
  boundedString,
  canonicalPluginId,
  canonicalSourceId,
  compareCodePoints,
  createCatalogEntryId,
  exactPluginIdentityKey,
  normalizeComponentInventory,
  normalizeSourceDisplay,
  optionalBoundedString,
  optionalRank,
  publisherId,
  requirePlainRecord,
  type CatalogSourceDisplay,
  type NormalizedPluginCatalogEntry,
  type PluginCatalogSource,
  type PluginInstallCapability,
  type PluginInstallKind,
  type PluginSourceKind,
  type SourcePluginRecord,
} from './source-types';

const SOURCE_KEYS = new Set([
  'canonicalSourceId',
  'display',
  'executionPreviewRequired',
  'installCapability',
  'installKind',
  'plugins',
  'publisherId',
  'publisherLabel',
  'sourceKind',
  'sourceRank',
  'sourceRevision',
]);
const PLUGIN_KEYS = new Set([
  'canonicalPluginId',
  'components',
  'description',
  'name',
  'sourceRevision',
  'version',
]);
const SOURCE_KINDS = new Set<PluginSourceKind>([
  'community',
  'demo',
  'official',
  'unknown',
  'user-marketplace',
]);
const INSTALL_CAPABILITIES = new Set<PluginInstallCapability>(['installable', 'unavailable']);
const INSTALL_KINDS = new Set<PluginInstallKind>([
  'bundled-demo',
  'claude-cli-marketplace',
  'none',
]);
const OFFICIAL_SOURCE_IDS = new Set(OFFICIAL_PLUGIN_SOURCE_ALLOWLIST);
const SOURCE_KIND_ORDER: Readonly<Record<PluginSourceKind, number>> = Object.freeze({
  community: 1,
  demo: 2,
  official: 0,
  unknown: 3,
  'user-marketplace': 3,
});

interface NormalizedSource {
  canonicalSourceId: string;
  display: CatalogSourceDisplay;
  executionPreviewRequired: boolean;
  installCapability: PluginInstallCapability;
  installKind: PluginInstallKind;
  plugins: readonly SourcePluginRecord[];
  publisherId: string;
  publisherLabel: string;
  sourceKind: PluginSourceKind;
  sourceRank?: number;
  sourceRevision?: string;
}

const sourceKind = (value: unknown): PluginSourceKind => {
  if (typeof value !== 'string' || !SOURCE_KINDS.has(value as PluginSourceKind)) {
    throw new PluginCatalogValidationError('Plugin source kind is invalid.');
  }
  return value as PluginSourceKind;
};

const installCapability = (value: unknown): PluginInstallCapability => {
  if (typeof value !== 'string' || !INSTALL_CAPABILITIES.has(value as PluginInstallCapability)) {
    throw new PluginCatalogValidationError('Plugin install capability is invalid.');
  }
  return value as PluginInstallCapability;
};

const installKind = (value: unknown): PluginInstallKind => {
  if (typeof value !== 'string' || !INSTALL_KINDS.has(value as PluginInstallKind)) {
    throw new PluginCatalogValidationError('Plugin install kind is invalid.');
  }
  return value as PluginInstallKind;
};

const assertInstallMetadata = (
  capability: PluginInstallCapability,
  kind: PluginInstallKind,
  previewRequired: boolean,
): void => {
  if (
    (capability === 'installable' && (kind === 'none' || !previewRequired)) ||
    (capability === 'unavailable' && kind !== 'none')
  ) {
    throw new PluginCatalogValidationError('Plugin install metadata is inconsistent.');
  }
};

const assertOfficialProvenance = (source: NormalizedSource): void => {
  if (source.sourceKind !== 'official') {
    return;
  }
  if (
    !OFFICIAL_SOURCE_IDS.has(source.canonicalSourceId) ||
    source.publisherId !== 'anthropic' ||
    source.publisherLabel !== 'Anthropic' ||
    source.display.label !== 'anthropics/claude-plugins-official' ||
    source.display.repositoryIdentity !== 'anthropics/claude-plugins-official' ||
    source.display.uri !== 'https://github.com/anthropics/claude-plugins-official' ||
    source.executionPreviewRequired !== true ||
    source.installCapability !== 'installable' ||
    source.installKind !== 'claude-cli-marketplace' ||
    source.sourceRank !== 0
  ) {
    throw new PluginCatalogValidationError('Official plugin source provenance is invalid.');
  }
};

const normalizeSource = (value: unknown): NormalizedSource => {
  const record = requirePlainRecord(value, 'Plugin catalog source record is invalid.');
  assertOnlyKeys(record, SOURCE_KEYS, 'Plugin catalog source contains unsupported fields.');
  if (
    !Array.isArray(record.plugins) ||
    record.plugins.length > PLUGIN_CATALOG_LIMITS.pluginsPerSource
  ) {
    throw new PluginCatalogValidationError('Plugin catalog source entries are invalid.');
  }
  if (typeof record.executionPreviewRequired !== 'boolean') {
    throw new PluginCatalogValidationError('Plugin execution preview metadata is invalid.');
  }
  const capability = installCapability(record.installCapability);
  const kind = installKind(record.installKind);
  assertInstallMetadata(capability, kind, record.executionPreviewRequired);
  const normalized: NormalizedSource = {
    canonicalSourceId: canonicalSourceId(record.canonicalSourceId),
    display: normalizeSourceDisplay(record.display),
    executionPreviewRequired: record.executionPreviewRequired,
    installCapability: capability,
    installKind: kind,
    plugins: record.plugins as readonly SourcePluginRecord[],
    publisherId: publisherId(record.publisherId),
    publisherLabel: boundedString(
      record.publisherLabel,
      PLUGIN_CATALOG_LIMITS.displayLength,
      'Plugin publisher label is invalid.',
    ),
    sourceKind: sourceKind(record.sourceKind),
    sourceRank: optionalRank(record.sourceRank),
    sourceRevision: optionalBoundedString(
      record.sourceRevision,
      PLUGIN_CATALOG_LIMITS.versionLength,
      'Plugin source revision is invalid.',
    ),
  };
  assertOfficialProvenance(normalized);
  return normalized;
};

const normalizeSourcePlugin = (value: unknown): SourcePluginRecord => {
  const record = requirePlainRecord(value, 'Plugin source entry is invalid.');
  assertOnlyKeys(record, PLUGIN_KEYS, 'Plugin source entry contains unsupported fields.');
  return {
    canonicalPluginId: canonicalPluginId(record.canonicalPluginId),
    components: normalizeComponentInventory(record.components),
    description: optionalBoundedString(
      record.description,
      PLUGIN_CATALOG_LIMITS.descriptionLength,
      'Plugin description is invalid.',
    ),
    name: boundedString(record.name, 160, 'Plugin name is invalid.'),
    sourceRevision: optionalBoundedString(
      record.sourceRevision,
      PLUGIN_CATALOG_LIMITS.versionLength,
      'Plugin source revision is invalid.',
    ),
    version: optionalBoundedString(
      record.version,
      PLUGIN_CATALOG_LIMITS.versionLength,
      'Plugin version is invalid.',
    ),
  };
};

const sourceFingerprint = (source: NormalizedSource): string =>
  JSON.stringify([
    source.canonicalSourceId,
    source.display.label,
    source.display.repositoryIdentity ?? null,
    source.display.uri ?? null,
    source.executionPreviewRequired,
    source.installCapability,
    source.installKind,
    source.publisherId,
    source.publisherLabel,
    source.sourceKind,
    source.sourceRank ?? null,
    source.sourceRevision ?? null,
  ]);

const entryFingerprint = (entry: NormalizedPluginCatalogEntry): string =>
  JSON.stringify([
    entry.canonicalPluginId,
    entry.canonicalSourceId,
    entry.catalogEntryId,
    entry.components ?? null,
    entry.description ?? null,
    entry.displaySource,
    entry.executionPreviewRequired,
    entry.installCapability,
    entry.installKind,
    entry.name,
    entry.publisherId,
    entry.publisherLabel,
    entry.recommendationRank ?? null,
    entry.recommendationReason ?? null,
    entry.recommendationTier,
    entry.sourceKind,
    entry.sourceRank ?? null,
    entry.sourceRevision ?? null,
    entry.version ?? null,
  ]);

const createEntry = (
  source: NormalizedSource,
  pluginValue: unknown,
): NormalizedPluginCatalogEntry => {
  const plugin = normalizeSourcePlugin(pluginValue);
  const recommendation = recommendPlugin({
    canonicalPluginId: plugin.canonicalPluginId,
    canonicalSourceId: source.canonicalSourceId,
    sourceKind: source.sourceKind,
  });
  return {
    canonicalPluginId: plugin.canonicalPluginId,
    canonicalSourceId: source.canonicalSourceId,
    catalogEntryId: createCatalogEntryId(source.canonicalSourceId, plugin.canonicalPluginId),
    components: plugin.components,
    description: plugin.description,
    displaySource: source.display,
    executionPreviewRequired: source.executionPreviewRequired,
    installCapability: source.installCapability,
    installKind: source.installKind,
    name: plugin.name,
    publisherId: source.publisherId,
    publisherLabel: source.publisherLabel,
    recommendationRank: recommendation.rank,
    recommendationReason: recommendation.reason,
    recommendationTier: recommendation.tier,
    sourceKind: source.sourceKind,
    sourceRank: source.sourceRank,
    sourceRevision: plugin.sourceRevision ?? source.sourceRevision,
    version: plugin.version,
  };
};

export const compareCatalogEntries = (
  left: NormalizedPluginCatalogEntry,
  right: NormalizedPluginCatalogEntry,
): number => {
  const kindDifference = SOURCE_KIND_ORDER[left.sourceKind] - SOURCE_KIND_ORDER[right.sourceKind];
  if (kindDifference !== 0) {
    return kindDifference;
  }
  const leftRank = left.sourceRank ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.sourceRank ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  const sourceDifference = compareCodePoints(left.canonicalSourceId, right.canonicalSourceId);
  if (sourceDifference !== 0) {
    return sourceDifference;
  }
  const leftRecommendationRank = left.recommendationRank ?? Number.MAX_SAFE_INTEGER;
  const rightRecommendationRank = right.recommendationRank ?? Number.MAX_SAFE_INTEGER;
  return leftRecommendationRank !== rightRecommendationRank
    ? leftRecommendationRank - rightRecommendationRank
    : compareCodePoints(left.canonicalPluginId, right.canonicalPluginId);
};

/**
 * Flattens only stamped sources. Exact duplicate inert entries coalesce; any conflicting reuse of an
 * authoritative source/plugin identity fails closed.
 */
export const normalizePluginCatalogSources = (
  values: readonly PluginCatalogSource[],
): readonly NormalizedPluginCatalogEntry[] => {
  if (!Array.isArray(values) || values.length > PLUGIN_CATALOG_LIMITS.sources) {
    throw new PluginCatalogValidationError('Plugin catalog source collection is invalid.');
  }
  const sourceFingerprints = new Map<string, string>();
  const entries = new Map<string, { entry: NormalizedPluginCatalogEntry; fingerprint: string }>();
  const catalogEntryIdentities = new Map<string, string>();
  let totalEntries = 0;

  for (const value of values) {
    const source = normalizeSource(value);
    totalEntries += source.plugins.length;
    if (totalEntries > PLUGIN_CATALOG_LIMITS.entries) {
      throw new PluginCatalogValidationError('Plugin catalog contains too many entries.');
    }
    const fingerprint = sourceFingerprint(source);
    const existingSource = sourceFingerprints.get(source.canonicalSourceId);
    if (existingSource && existingSource !== fingerprint) {
      throw new PluginCatalogValidationError('Plugin catalog source identity conflicts.');
    }
    sourceFingerprints.set(source.canonicalSourceId, fingerprint);

    for (const plugin of source.plugins) {
      const entry = createEntry(source, plugin);
      const identity = exactPluginIdentityKey(entry.canonicalSourceId, entry.canonicalPluginId);
      const existingCatalogIdentity = catalogEntryIdentities.get(entry.catalogEntryId);
      if (existingCatalogIdentity && existingCatalogIdentity !== identity) {
        throw new PluginCatalogValidationError('Plugin catalog presentation identity conflicts.');
      }
      catalogEntryIdentities.set(entry.catalogEntryId, identity);
      const normalizedFingerprint = entryFingerprint(entry);
      const existing = entries.get(identity);
      if (existing && existing.fingerprint !== normalizedFingerprint) {
        throw new PluginCatalogValidationError('Plugin catalog entry identity conflicts.');
      }
      if (!existing) {
        entries.set(identity, { entry, fingerprint: normalizedFingerprint });
      }
    }
  }

  return [...entries.values()].map(({ entry }) => entry).sort(compareCatalogEntries);
};
