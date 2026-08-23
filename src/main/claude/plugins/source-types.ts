import { createHash } from 'node:crypto';

export const PLUGIN_CATALOG_LIMITS = Object.freeze({
  componentsPerKind: 64,
  descriptionLength: 4_096,
  displayLength: 1_024,
  entries: 10_000,
  identifierLength: 512,
  pluginsPerSource: 2_048,
  remoteTextLength: 64 * 1_024,
  sources: 256,
  versionLength: 160,
});

export type PluginSourceKind = 'official' | 'community' | 'demo' | 'user-marketplace' | 'unknown';

export type PluginRecommendationTier = 'official' | 'community' | 'demo' | 'none';

export type PluginInstallCapability = 'installable' | 'unavailable';

export type PluginInstallKind = 'claude-cli-marketplace' | 'bundled-demo' | 'none';

export type PluginScope = 'local' | 'project' | 'user';

export interface PluginComponentInventory {
  agents: readonly string[];
  commands: readonly string[];
  hooks: readonly string[];
  mcpServers: readonly string[];
  skills: readonly string[];
}

export interface CatalogSourceDisplay {
  /** Bounded, presentation-safe text. It may describe itself as official without gaining trust. */
  label: string;
  /** A credential-free URI with userinfo, query and fragment absent. */
  uri?: string;
  /** Canonical `owner/repository` identity when the source is a supported repository host. */
  repositoryIdentity?: string;
}

export interface SourcePluginRecord {
  canonicalPluginId: string;
  components?: PluginComponentInventory;
  description?: string;
  name: string;
  sourceRevision?: string;
  version?: string;
}

export interface PluginCatalogSource {
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

/**
 * Installed state is deliberately provenance-free. Only an exact match against a stamped catalog
 * source may lend it known provenance; an unmatched record is presented as `unknown`.
 */
export interface InstalledPluginRecord {
  canonicalPluginId: string;
  canonicalSourceId: string;
  components?: PluginComponentInventory;
  description?: string;
  display?: CatalogSourceDisplay;
  enabled?: boolean;
  name: string;
  scope?: PluginScope;
  sourceRevision?: string;
  updateAvailable?: boolean;
  version?: string;
}

export interface NormalizedPluginCatalogEntry {
  canonicalPluginId: string;
  canonicalSourceId: string;
  catalogEntryId: string;
  components?: PluginComponentInventory;
  description?: string;
  displaySource: CatalogSourceDisplay;
  executionPreviewRequired: boolean;
  installCapability: PluginInstallCapability;
  installKind: PluginInstallKind;
  name: string;
  publisherId: string;
  publisherLabel: string;
  recommendationRank?: number;
  recommendationReason?: string;
  recommendationTier: PluginRecommendationTier;
  sourceKind: PluginSourceKind;
  sourceRank?: number;
  sourceRevision?: string;
  version?: string;
}

export interface PluginCatalogEntry extends NormalizedPluginCatalogEntry {
  enabled?: boolean;
  installed: boolean;
  installedSourceRevision?: string;
  installedVersion?: string;
  latestSourceRevision?: string;
  latestVersion?: string;
  scope?: PluginScope;
  updateAvailable: boolean;
}

export interface PluginCatalogSnapshot {
  checkedAt: number;
  entries: readonly PluginCatalogEntry[];
  installedCount: number;
  updatesAvailable: number;
}

export interface GitHubRepositoryIdentity {
  canonicalSourceId: string;
  owner: string;
  repository: string;
  repositoryIdentity: string;
  uri: string;
}

export class PluginCatalogValidationError extends Error {
  public constructor(message = 'Plugin catalog data is invalid.') {
    super(message);
    this.name = 'PluginCatalogValidationError';
  }
}

const hasDisallowedTextControl = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    );
  });
const SOURCE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9+._:/@-]{0,511}$/;
const PUBLISHER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PLUGIN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const URI_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const BARE_DISPLAY_URI = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::[0-9]{1,5})?(?:[/?#]|$)/;
const BARE_USERINFO_AUTHORITY =
  /^[^\s/@]+@(?:\[[^\]\s/?#]+\]|[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\.?)(?::[0-9]+(?:[/?#]|$)|[/?#])/;

export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor,
  );
};

export const requirePlainRecord = (
  value: unknown,
  message = 'Plugin catalog record is invalid.',
): Record<string, unknown> => {
  if (!isPlainRecord(value)) {
    throw new PluginCatalogValidationError(message);
  }
  return value;
};

export const assertOnlyKeys = (
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  message = 'Plugin catalog record contains unsupported fields.',
): void => {
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new PluginCatalogValidationError(message);
  }
};

export const boundedString = (
  value: unknown,
  maximumLength: number,
  message = 'Plugin catalog text is invalid.',
): string => {
  if (typeof value !== 'string') {
    throw new PluginCatalogValidationError(message);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumLength || hasDisallowedTextControl(trimmed)) {
    throw new PluginCatalogValidationError(message);
  }
  return trimmed;
};

export const optionalBoundedString = (
  value: unknown,
  maximumLength: number,
  message = 'Plugin catalog text is invalid.',
): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  return boundedString(value, maximumLength, message);
};

export const canonicalSourceId = (value: unknown): string => {
  const identifier = boundedString(
    value,
    PLUGIN_CATALOG_LIMITS.identifierLength,
    'Plugin catalog source identity is invalid.',
  );
  if (!SOURCE_IDENTIFIER.test(identifier)) {
    throw new PluginCatalogValidationError('Plugin catalog source identity is invalid.');
  }
  return identifier;
};

export const publisherId = (value: unknown): string => {
  const identifier = boundedString(value, 160, 'Plugin publisher identity is invalid.');
  if (!PUBLISHER_IDENTIFIER.test(identifier)) {
    throw new PluginCatalogValidationError('Plugin publisher identity is invalid.');
  }
  return identifier;
};

export const canonicalPluginId = (value: unknown): string => {
  const identifier = boundedString(value, 160, 'Plugin identity is invalid.');
  if (!PLUGIN_IDENTIFIER.test(identifier)) {
    throw new PluginCatalogValidationError('Plugin identity is invalid.');
  }
  return identifier;
};

export const optionalRank = (value: unknown): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new PluginCatalogValidationError('Plugin catalog rank is invalid.');
  }
  return value as number;
};

export const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
};

export const exactPluginIdentityKey = (sourceId: string, pluginId: string): string =>
  `${sourceId.length}:${sourceId}${pluginId.length}:${pluginId}`;

export const createCatalogEntryId = (sourceId: string, pluginId: string): string => {
  const identity = exactPluginIdentityKey(sourceId, pluginId);
  return `plugin:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
};

export const sanitizeDisplayUri = (value: unknown): string => {
  const raw = boundedString(value, 2_048, 'Plugin catalog URL is not safe to display.');
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    throw new PluginCatalogValidationError('Plugin catalog URL is not safe to display.');
  }
  if (
    (uri.protocol !== 'https:' && uri.protocol !== 'http:') ||
    !uri.hostname ||
    uri.username ||
    uri.password
  ) {
    throw new PluginCatalogValidationError('Plugin catalog URL is not safe to display.');
  }
  uri.username = '';
  uri.password = '';
  uri.search = '';
  uri.hash = '';
  return uri.toString();
};

export const sanitizeDisplaySourceValue = (value: unknown): string => {
  const display = boundedString(
    value,
    PLUGIN_CATALOG_LIMITS.displayLength,
    'Plugin source display value is invalid.',
  );
  if (WINDOWS_ABSOLUTE_PATH.test(display) || display.startsWith('/')) {
    return 'Local marketplace';
  }
  if (URI_PREFIX.test(display)) {
    return sanitizeDisplayUri(display);
  }
  if (BARE_USERINFO_AUTHORITY.test(display)) {
    throw new PluginCatalogValidationError('Plugin catalog URL is not safe to display.');
  }
  if (BARE_DISPLAY_URI.test(display)) {
    return sanitizeDisplayUri(`https://${display}`).replace(/^https:\/\//, '');
  }
  return display;
};

export const normalizeSourceDisplay = (value: unknown): CatalogSourceDisplay => {
  const record = requirePlainRecord(value, 'Plugin source display record is invalid.');
  assertOnlyKeys(
    record,
    new Set(['label', 'repositoryIdentity', 'uri']),
    'Plugin source display record contains unsupported fields.',
  );
  const label = sanitizeDisplaySourceValue(record.label);
  const uri = record.uri === undefined ? undefined : sanitizeDisplayUri(record.uri);
  const repositoryDisplay = optionalBoundedString(
    record.repositoryIdentity,
    201,
    'Plugin repository display identity is invalid.',
  );
  const repositoryIdentity = repositoryDisplay
    ? normalizeGitHubRepositoryIdentity(repositoryDisplay)?.repositoryIdentity
    : undefined;
  if (repositoryDisplay && !repositoryIdentity) {
    throw new PluginCatalogValidationError('Plugin repository display identity is invalid.');
  }
  return { label, repositoryIdentity, uri };
};

const COMPONENT_KEYS = new Set(['agents', 'commands', 'hooks', 'mcpServers', 'skills']);

const normalizeComponentNames = (value: unknown): readonly string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > PLUGIN_CATALOG_LIMITS.componentsPerKind) {
    throw new PluginCatalogValidationError('Plugin component inventory is invalid.');
  }
  const names = value.map((name) =>
    boundedString(name, 160, 'Plugin component inventory is invalid.'),
  );
  return [...new Set(names)].sort(compareCodePoints);
};

export const normalizeComponentInventory = (
  value: unknown,
): PluginComponentInventory | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requirePlainRecord(value, 'Plugin component inventory is invalid.');
  assertOnlyKeys(record, COMPONENT_KEYS, 'Plugin component inventory contains unsupported fields.');
  const inventory: PluginComponentInventory = {
    agents: normalizeComponentNames(record.agents),
    commands: normalizeComponentNames(record.commands),
    hooks: normalizeComponentNames(record.hooks),
    mcpServers: normalizeComponentNames(record.mcpServers),
    skills: normalizeComponentNames(record.skills),
  };
  return Object.values(inventory).some((names) => names.length > 0) ? inventory : undefined;
};

export const normalizeGitHubRepositoryIdentity = (
  value: unknown,
): GitHubRepositoryIdentity | undefined => {
  const raw = boundedString(value, 2_048, 'Plugin repository identity is invalid.');
  let repositoryPath = raw;

  if (URI_PREFIX.test(raw)) {
    const sanitized = sanitizeDisplayUri(raw);
    const uri = new URL(sanitized);
    if (uri.protocol !== 'https:' || !/^(?:www\.)?github\.com$/i.test(uri.hostname)) {
      return undefined;
    }
    repositoryPath = uri.pathname.replace(/^\/+|\/+$/g, '');
  } else {
    repositoryPath = repositoryPath.replace(/^github:/i, '').replace(/^github\.com\//i, '');
  }

  repositoryPath = repositoryPath.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const segments = repositoryPath.split('/');
  const owner = segments[0];
  const repository = segments[1];
  if (
    segments.length !== 2 ||
    !owner ||
    !repository ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(repository)
  ) {
    return undefined;
  }

  const canonicalOwner = owner.toLowerCase();
  const canonicalRepository = repository.toLowerCase();
  const repositoryIdentity = `${canonicalOwner}/${canonicalRepository}`;
  return {
    canonicalSourceId: `github:${repositoryIdentity}`,
    owner: canonicalOwner,
    repository: canonicalRepository,
    repositoryIdentity,
    uri: `https://github.com/${repositoryIdentity}`,
  };
};
