import { adaptClaudeCliPluginRecords } from './claude-cli-record-adapter';
import {
  PLUGIN_CATALOG_LIMITS,
  PluginCatalogValidationError,
  assertOnlyKeys,
  normalizeGitHubRepositoryIdentity,
  optionalBoundedString,
  requirePlainRecord,
  type GitHubRepositoryIdentity,
  type PluginCatalogSource,
  type SourcePluginRecord,
} from './source-types';

export const ANTHROPIC_OFFICIAL_MARKETPLACE_REPOSITORY =
  'github:anthropics/claude-plugins-official';

export const OFFICIAL_PLUGIN_SOURCE_ALLOWLIST: readonly string[] = Object.freeze([
  ANTHROPIC_OFFICIAL_MARKETPLACE_REPOSITORY,
]);

const OFFICIAL_SOURCE_IDS = new Set(OFFICIAL_PLUGIN_SOURCE_ALLOWLIST);
const OFFICIAL_CLI_SOURCE_KEYS = new Set(['plugins', 'repository', 'revision']);

export interface OfficialClaudeCliSourceInput {
  plugins: unknown;
  repository: unknown;
  revision?: unknown;
}

/**
 * Recognition is based only on the exact normalized repository identity. Marketplace names, labels,
 * localized prose and any string containing "official" are deliberately irrelevant.
 */
export const recognizeOfficialPluginRepository = (
  value: unknown,
): GitHubRepositoryIdentity | undefined => {
  const repository = normalizeGitHubRepositoryIdentity(value);
  return repository && OFFICIAL_SOURCE_IDS.has(repository.canonicalSourceId)
    ? repository
    : undefined;
};

export const createAnthropicOfficialCatalogSource = (
  repositoryValue: unknown,
  plugins: readonly SourcePluginRecord[],
  revisionValue?: unknown,
): PluginCatalogSource => {
  const repository = recognizeOfficialPluginRepository(repositoryValue);
  if (!repository) {
    throw new PluginCatalogValidationError('Plugin catalog source is not recognized as official.');
  }
  const sourceRevision = optionalBoundedString(
    revisionValue,
    PLUGIN_CATALOG_LIMITS.versionLength,
    'Official plugin source revision is invalid.',
  );
  return {
    canonicalSourceId: repository.canonicalSourceId,
    display: {
      label: repository.repositoryIdentity,
      repositoryIdentity: repository.repositoryIdentity,
      uri: repository.uri,
    },
    executionPreviewRequired: true,
    installCapability: 'installable',
    installKind: 'claude-cli-marketplace',
    plugins,
    publisherId: 'anthropic',
    publisherLabel: 'Anthropic',
    sourceKind: 'official',
    sourceRank: 0,
    sourceRevision,
  };
};

export const adaptAnthropicOfficialClaudeCliSource = (input: unknown): PluginCatalogSource => {
  const record = requirePlainRecord(input, 'Official plugin source record is invalid.');
  assertOnlyKeys(
    record,
    OFFICIAL_CLI_SOURCE_KEYS,
    'Official plugin source record contains unsupported fields.',
  );
  return createAnthropicOfficialCatalogSource(
    record.repository,
    adaptClaudeCliPluginRecords(record.plugins),
    record.revision,
  );
};
