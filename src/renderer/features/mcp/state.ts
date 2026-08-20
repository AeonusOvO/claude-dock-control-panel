import type { McpCatalog } from '../../../shared/contracts';

export interface McpState {
  catalog?: McpCatalog;
  loadPromise?: Promise<void>;
  mutationInProgress: boolean;
  renderedContext: string | null;
  renderedKeys: ReadonlySet<string>;
}

export const createMcpState = (): McpState => ({
  mutationInProgress: false,
  renderedContext: null,
  renderedKeys: new Set<string>(),
});
