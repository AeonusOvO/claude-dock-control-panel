import {
  PLUGIN_CATALOG_LIMITS,
  PluginCatalogValidationError,
  assertOnlyKeys,
  boundedString,
  canonicalPluginId,
  canonicalSourceId,
  normalizeComponentInventory,
  normalizeSourceDisplay,
  optionalBoundedString,
  requirePlainRecord,
  sanitizeDisplayUri,
  type CatalogSourceDisplay,
  type InstalledPluginRecord,
  type PluginCatalogSource,
  type PluginScope,
  type SourcePluginRecord,
} from './source-types';

const CLI_PLUGIN_KEYS = new Set([
  'catalogText',
  'category',
  'components',
  'description',
  'downloads',
  'enabled',
  'id',
  'installCount',
  'installed',
  'installedAt',
  'installPath',
  'labels',
  'lastUpdated',
  'latestVersion',
  'localizations',
  'manifest',
  'marketplaceName',
  'name',
  'pluginId',
  'readme',
  'scope',
  'source',
  'sourceRevision',
  'stars',
  'updateAvailable',
  'version',
]);

const CLI_SOURCE_KEYS = new Set(['path', 'ref', 'sha', 'source', 'url']);
const LOCALIZATION_KEYS = new Set(['description', 'label', 'locale', 'name']);
const PLUGIN_COMPOSITE_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,159})?$/;

export interface ClaudeCliRecordContext {
  /** Exact identity established by the main-owned marketplace/source adapter. */
  canonicalSourceId: string;
  /** Optional presentation-safe source data; it never changes provenance. */
  display?: CatalogSourceDisplay;
}

export interface ClaudeCliMarketplaceSourceContext extends ClaudeCliRecordContext {
  publisherId?: string;
  publisherLabel?: string;
  sourceKind: 'unknown' | 'user-marketplace';
  sourceRank?: number;
  sourceRevision?: string;
}

interface ParsedPluginIdentity {
  canonicalPluginId: string;
  name: string;
}

const optionalVersion = (value: unknown): string | undefined => {
  const version = optionalBoundedString(
    value,
    PLUGIN_CATALOG_LIMITS.versionLength,
    'Claude CLI plugin version is invalid.',
  );
  return version?.toLowerCase() === 'unknown' ? undefined : version;
};

const validateCount = (value: unknown): void => {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000)
  ) {
    throw new PluginCatalogValidationError('Claude CLI plugin count is invalid.');
  }
};

const validateStringArray = (value: unknown, maximumLength: number): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length > PLUGIN_CATALOG_LIMITS.componentsPerKind) {
    throw new PluginCatalogValidationError('Claude CLI plugin metadata is invalid.');
  }
  for (const item of value) {
    boundedString(item, maximumLength, 'Claude CLI plugin metadata is invalid.');
  }
};

const validateLocalizations = (value: unknown): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new PluginCatalogValidationError('Claude CLI plugin localization is invalid.');
  }
  for (const item of value) {
    const record = requirePlainRecord(item, 'Claude CLI plugin localization is invalid.');
    assertOnlyKeys(record, LOCALIZATION_KEYS, 'Claude CLI plugin localization is invalid.');
    optionalBoundedString(record.locale, 35, 'Claude CLI plugin localization is invalid.');
    optionalBoundedString(record.name, 160, 'Claude CLI plugin localization is invalid.');
    optionalBoundedString(
      record.label,
      PLUGIN_CATALOG_LIMITS.displayLength,
      'Claude CLI plugin localization is invalid.',
    );
    optionalBoundedString(
      record.description,
      PLUGIN_CATALOG_LIMITS.descriptionLength,
      'Claude CLI plugin localization is invalid.',
    );
  }
};

const validateIgnoredMetadata = (record: Record<string, unknown>): void => {
  optionalBoundedString(record.category, 160, 'Claude CLI plugin metadata is invalid.');
  optionalBoundedString(record.installedAt, 160, 'Claude CLI plugin metadata is invalid.');
  optionalBoundedString(record.installPath, 4_096, 'Claude CLI plugin metadata is invalid.');
  optionalBoundedString(record.lastUpdated, 160, 'Claude CLI plugin metadata is invalid.');
  optionalBoundedString(
    record.marketplaceName,
    160,
    'Claude CLI plugin marketplace name is invalid.',
  );
  for (const key of ['catalogText', 'manifest', 'readme'] as const) {
    optionalBoundedString(
      record[key],
      PLUGIN_CATALOG_LIMITS.remoteTextLength,
      'Claude CLI plugin remote text is invalid.',
    );
  }
  validateCount(record.downloads);
  validateCount(record.installCount);
  validateCount(record.stars);
  validateStringArray(record.labels, PLUGIN_CATALOG_LIMITS.displayLength);
  validateLocalizations(record.localizations);
};

const sourceRevision = (record: Record<string, unknown>): string | undefined => {
  const direct = optionalBoundedString(
    record.sourceRevision,
    PLUGIN_CATALOG_LIMITS.versionLength,
    'Claude CLI plugin source revision is invalid.',
  );
  if (record.source === undefined || record.source === null) {
    return direct;
  }
  if (typeof record.source === 'string') {
    const source = boundedString(record.source, 4_096, 'Claude CLI plugin source is invalid.');
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
      sanitizeDisplayUri(source);
    }
    return direct;
  }

  const source = requirePlainRecord(record.source, 'Claude CLI plugin source is invalid.');
  assertOnlyKeys(source, CLI_SOURCE_KEYS, 'Claude CLI plugin source contains unsupported fields.');
  optionalBoundedString(source.path, 1_024, 'Claude CLI plugin source is invalid.');
  optionalBoundedString(source.ref, 160, 'Claude CLI plugin source is invalid.');
  optionalBoundedString(source.source, 1_024, 'Claude CLI plugin source is invalid.');
  const nestedRevision = optionalBoundedString(
    source.sha,
    PLUGIN_CATALOG_LIMITS.versionLength,
    'Claude CLI plugin source revision is invalid.',
  );
  if (source.url !== undefined) {
    sanitizeDisplayUri(source.url);
  }
  if (direct && nestedRevision && direct !== nestedRevision) {
    throw new PluginCatalogValidationError('Claude CLI plugin source revisions conflict.');
  }
  return direct ?? nestedRevision;
};

const parseCompositeId = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const identifier = boundedString(value, 321, 'Claude CLI plugin identity is invalid.');
  if (!PLUGIN_COMPOSITE_ID.test(identifier)) {
    throw new PluginCatalogValidationError('Claude CLI plugin identity is invalid.');
  }
  return identifier;
};

const parsePluginIdentity = (record: Record<string, unknown>): ParsedPluginIdentity => {
  const pluginId = parseCompositeId(record.pluginId);
  const installedId = parseCompositeId(record.id);
  if (pluginId && installedId && pluginId !== installedId) {
    throw new PluginCatalogValidationError('Claude CLI plugin identities conflict.');
  }
  const compositeId = pluginId ?? installedId;
  const idName = compositeId?.split('@', 1)[0];
  const declaredName = record.name === undefined ? undefined : canonicalPluginId(record.name);
  if (idName && declaredName && idName !== declaredName) {
    throw new PluginCatalogValidationError('Claude CLI plugin identities conflict.');
  }
  const identity = canonicalPluginId(idName ?? declaredName);
  return { canonicalPluginId: identity, name: declaredName ?? identity };
};

const parsePluginRecord = (
  value: unknown,
): {
  record: Record<string, unknown>;
  sourcePlugin: SourcePluginRecord;
} => {
  const record = requirePlainRecord(value, 'Claude CLI plugin record is invalid.');
  assertOnlyKeys(record, CLI_PLUGIN_KEYS, 'Claude CLI plugin record contains unsupported fields.');
  validateIgnoredMetadata(record);
  const identity = parsePluginIdentity(record);
  const sourcePlugin: SourcePluginRecord = {
    ...identity,
    components: normalizeComponentInventory(record.components),
    description: optionalBoundedString(
      record.description,
      PLUGIN_CATALOG_LIMITS.descriptionLength,
      'Claude CLI plugin description is invalid.',
    ),
    sourceRevision: sourceRevision(record),
    version: optionalVersion(record.version ?? record.latestVersion),
  };
  return { record, sourcePlugin };
};

export const adaptClaudeCliPluginRecord = (value: unknown): SourcePluginRecord =>
  parsePluginRecord(value).sourcePlugin;

export const adaptClaudeCliPluginRecords = (value: unknown): readonly SourcePluginRecord[] => {
  if (!Array.isArray(value) || value.length > PLUGIN_CATALOG_LIMITS.pluginsPerSource) {
    throw new PluginCatalogValidationError('Claude CLI plugin record collection is invalid.');
  }
  return value.map(adaptClaudeCliPluginRecord);
};

/**
 * Builds only non-authoritative CLI sources. Official provenance must go through the exact repository
 * adapter in `official-source.ts`; CLI marketplace names and prose cannot select it here.
 */
export const adaptClaudeCliMarketplaceSource = (
  value: unknown,
  context: ClaudeCliMarketplaceSourceContext,
): PluginCatalogSource => {
  if (context.sourceKind !== 'unknown' && context.sourceKind !== 'user-marketplace') {
    throw new PluginCatalogValidationError('Claude CLI source kind is invalid.');
  }
  const knownUserSource = context.sourceKind === 'user-marketplace';
  return {
    canonicalSourceId: canonicalSourceId(context.canonicalSourceId),
    display: context.display
      ? normalizeSourceDisplay(context.display)
      : { label: knownUserSource ? 'User marketplace' : 'Unknown plugin source' },
    executionPreviewRequired: knownUserSource,
    installCapability: knownUserSource ? 'installable' : 'unavailable',
    installKind: knownUserSource ? 'claude-cli-marketplace' : 'none',
    plugins: adaptClaudeCliPluginRecords(value),
    publisherId: context.publisherId ?? (knownUserSource ? 'user-marketplace' : 'unknown'),
    publisherLabel:
      context.publisherLabel ?? (knownUserSource ? 'User marketplace' : 'Unknown publisher'),
    sourceKind: context.sourceKind,
    sourceRank: context.sourceRank,
    sourceRevision: context.sourceRevision,
  };
};

const parseScope = (value: unknown): PluginScope | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== 'local' && value !== 'project' && value !== 'user') {
    throw new PluginCatalogValidationError('Claude CLI plugin scope is invalid.');
  }
  return value;
};

export const adaptClaudeCliInstalledRecord = (
  value: unknown,
  context: ClaudeCliRecordContext,
): InstalledPluginRecord => {
  const { record, sourcePlugin } = parsePluginRecord(value);
  const exactSourceId = canonicalSourceId(context.canonicalSourceId);
  const display = context.display ? normalizeSourceDisplay(context.display) : undefined;
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new PluginCatalogValidationError('Claude CLI plugin enabled state is invalid.');
  }
  if (record.updateAvailable !== undefined && typeof record.updateAvailable !== 'boolean') {
    throw new PluginCatalogValidationError('Claude CLI plugin update state is invalid.');
  }
  return {
    ...sourcePlugin,
    canonicalSourceId: exactSourceId,
    display,
    enabled: record.enabled as boolean | undefined,
    scope: parseScope(record.scope),
    updateAvailable: record.updateAvailable as boolean | undefined,
  };
};

export const adaptClaudeCliInstalledRecords = (
  value: unknown,
  context: ClaudeCliRecordContext,
): readonly InstalledPluginRecord[] => {
  if (!Array.isArray(value) || value.length > PLUGIN_CATALOG_LIMITS.entries) {
    throw new PluginCatalogValidationError('Claude CLI installed plugin collection is invalid.');
  }
  return value.map((record) => adaptClaudeCliInstalledRecord(record, context));
};
