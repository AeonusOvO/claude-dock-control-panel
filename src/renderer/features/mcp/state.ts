import type { McpCatalog } from '../../../shared/contracts';

export interface McpState {
  /** Cwd whose catalog/mutation result is currently allowed to own the page. */
  activeCwd?: string;
  /** Monotonic ownership token for active-cwd changes. */
  activeCwdGeneration: number;
  catalog?: McpCatalog;
  catalogCwd?: string;
  loadCwd?: string;
  loadPromise?: Promise<void>;
  mutationInProgress: boolean;
  renderedAvailableKeys: ReadonlySet<string>;
  renderedContext: string | null;
  renderedInstalledKeys: ReadonlySet<string>;
  disposed: boolean;
}

export const createMcpState = (): McpState => ({
  activeCwd: undefined,
  activeCwdGeneration: 0,
  disposed: false,
  mutationInProgress: false,
  renderedAvailableKeys: new Set<string>(),
  renderedContext: null,
  renderedInstalledKeys: new Set<string>(),
});
