import type { ClaudePluginCatalog } from '../../../shared/contracts';

export interface PluginOperationToken {
  readonly kind: 'load' | 'mutation' | 'refresh';
  readonly sequence: number;
}

export interface PluginsState {
  activeOperationPollAttempt?: number;
  activeOperationPollInFlight: boolean;
  activeOperationPollTimer?: ReturnType<typeof setTimeout>;
  catalog?: ClaudePluginCatalog;
  disposed: boolean;
  loadOperation?: PluginOperationToken;
  loadPromise?: Promise<void>;
  mutationInProgress: boolean;
  mutationOperation?: PluginOperationToken;
  nextOperationSequence: number;
  refreshOperation?: PluginOperationToken;
  refreshPromise?: Promise<boolean>;
  renderedContext: string | null;
  renderedKeys: ReadonlySet<string>;
}

export const createPluginsState = (): PluginsState => ({
  activeOperationPollInFlight: false,
  disposed: false,
  mutationInProgress: false,
  nextOperationSequence: 1,
  renderedContext: null,
  renderedKeys: new Set<string>(),
});

export const beginPluginOperation = (
  state: PluginsState,
  kind: PluginOperationToken['kind'],
): PluginOperationToken => Object.freeze({ kind, sequence: state.nextOperationSequence++ });

export const pluginOperationInProgress = (state: PluginsState): boolean =>
  Boolean(
    state.catalog?.activeOperation ||
    state.loadOperation ||
    state.mutationOperation ||
    state.refreshOperation,
  );

export const ownsPluginOperation = (
  active: PluginOperationToken | undefined,
  operation: PluginOperationToken,
): boolean => active === operation;
