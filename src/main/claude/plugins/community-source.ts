import type {
  CatalogSourceDisplay,
  PluginCatalogSource,
  PluginInstallCapability,
  PluginInstallKind,
  SourcePluginRecord,
} from './source-types';

export interface CommunityCatalogSourceDefinition {
  canonicalSourceId: string;
  display: CatalogSourceDisplay;
  executionPreviewRequired?: boolean;
  installCapability?: PluginInstallCapability;
  installKind?: PluginInstallKind;
  plugins: readonly SourcePluginRecord[];
  publisherId: string;
  publisherLabel: string;
  sourceRank?: number;
  sourceRevision?: string;
}

/** Creates a main-owned community source. No remote field can select this adapter. */
export const createCommunityCatalogSource = (
  definition: CommunityCatalogSourceDefinition,
): PluginCatalogSource => ({
  canonicalSourceId: definition.canonicalSourceId,
  display: definition.display,
  executionPreviewRequired: definition.executionPreviewRequired ?? false,
  installCapability: definition.installCapability ?? 'unavailable',
  installKind: definition.installKind ?? 'none',
  plugins: definition.plugins,
  publisherId: definition.publisherId,
  publisherLabel: definition.publisherLabel,
  sourceKind: 'community',
  sourceRank: definition.sourceRank,
  sourceRevision: definition.sourceRevision,
});

/** Offline-only inert product data; it contains no executable plan, path or remote URL. */
export const BUNDLED_COMMUNITY_SOURCES: readonly PluginCatalogSource[] = Object.freeze([
  createCommunityCatalogSource({
    canonicalSourceId: 'bundled:claudedock/community-examples',
    display: { label: 'ClaudeDock community examples' },
    plugins: [
      {
        canonicalPluginId: 'community-workflow-example',
        description: 'An inert bundled community catalog example for offline presentation.',
        name: 'Community workflow example',
        version: '1',
      },
    ],
    publisherId: 'claudedock-community',
    publisherLabel: 'ClaudeDock Community',
    sourceRank: 100,
    sourceRevision: 'bundled-v1',
  }),
]);
