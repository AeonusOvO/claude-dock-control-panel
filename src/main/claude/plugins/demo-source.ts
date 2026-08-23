import type {
  CatalogSourceDisplay,
  PluginCatalogSource,
  PluginInstallCapability,
  PluginInstallKind,
  SourcePluginRecord,
} from './source-types';

export interface DemoCatalogSourceDefinition {
  canonicalSourceId: string;
  display: CatalogSourceDisplay;
  executionPreviewRequired?: boolean;
  installCapability?: PluginInstallCapability;
  installKind?: PluginInstallKind;
  plugins: readonly SourcePluginRecord[];
  publisherId?: string;
  publisherLabel?: string;
  sourceRank?: number;
  sourceRevision?: string;
}

/** Creates app-owned demo metadata. Creation itself performs no copy, install or mutation. */
export const createDemoCatalogSource = (
  definition: DemoCatalogSourceDefinition,
): PluginCatalogSource => ({
  canonicalSourceId: definition.canonicalSourceId,
  display: definition.display,
  executionPreviewRequired: definition.executionPreviewRequired ?? true,
  installCapability: definition.installCapability ?? 'installable',
  installKind: definition.installKind ?? 'bundled-demo',
  plugins: definition.plugins,
  publisherId: definition.publisherId ?? 'claudedock',
  publisherLabel: definition.publisherLabel ?? 'ClaudeDock',
  sourceKind: 'demo',
  sourceRank: definition.sourceRank,
  sourceRevision: definition.sourceRevision,
});

/** Offline-only inert product data; it contains no command, absolute path or remote URL. */
export const BUNDLED_DEMO_SOURCES: readonly PluginCatalogSource[] = Object.freeze([
  createDemoCatalogSource({
    canonicalSourceId: 'bundled:claudedock/demo',
    display: { label: 'ClaudeDock plugin demo' },
    plugins: [
      {
        canonicalPluginId: 'hello-claudedock',
        components: {
          agents: [],
          commands: ['hello-claudedock'],
          hooks: [],
          mcpServers: [],
          skills: [],
        },
        description: 'A bundled inert record used to demonstrate plugin presentation and consent.',
        name: 'Hello ClaudeDock',
        version: '1',
      },
    ],
    sourceRank: 200,
    sourceRevision: 'bundled-v1',
  }),
]);
