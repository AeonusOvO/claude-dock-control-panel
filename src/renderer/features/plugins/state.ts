import type { ClaudePluginCatalog } from '../../../shared/contracts';

export interface PluginsState {
  catalog?: ClaudePluginCatalog;
  loadPromise?: Promise<void>;
  mutationInProgress: boolean;
  renderedContext: string | null;
  renderedKeys: ReadonlySet<string>;
}

export const createPluginsState = (): PluginsState => ({
  mutationInProgress: false,
  renderedContext: null,
  renderedKeys: new Set<string>(),
});
