import { createRegistryToken, type Registry } from '../../platform/registry';
import { createMcpActions, type McpActions, type McpActionsDependencies } from './actions';
import { createMcpElements } from './elements';
import { createMcpState } from './state';
import { createMcpView } from './view';

export type McpFeatureDependencies = McpActionsDependencies;

export interface McpFeature {
  dispose: () => void;
  loadCatalog: (refreshRegistry: boolean) => Promise<void>;
}

export const MCP_FEATURE = createRegistryToken<McpFeature>('renderer.feature.mcp');

const createMcpFeature = (dependencies: McpFeatureDependencies): McpFeature => {
  const elements = createMcpElements();
  const state = createMcpState();
  const actionsDelegate: { current?: McpActions } = {};
  const resolveActions = (): McpActions => {
    if (!actionsDelegate.current) {
      throw new Error('MCP actions are not initialized.');
    }
    return actionsDelegate.current;
  };
  const view = createMcpView(elements, state, {
    getActiveStatus: dependencies.getActiveStatus,
    onInstall: (entry, cwd, button) => resolveActions().installServer(entry, cwd, button),
    onRemove: (server, cwd, button) => resolveActions().removeServer(server, cwd, button),
    onToggle: (server, cwd, button) => resolveActions().toggleServer(server, cwd, button),
  });
  const actions = createMcpActions(elements, state, dependencies, view);
  actionsDelegate.current = actions;
  const dispose = actions.bind();

  return {
    dispose,
    loadCatalog: actions.loadCatalog,
  };
};

export const registerMcpFeature = (
  registry: Registry,
  dependencies: McpFeatureDependencies,
): void => {
  registry.register(MCP_FEATURE, () => createMcpFeature(dependencies));
};
