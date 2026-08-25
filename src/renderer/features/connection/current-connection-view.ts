import type {
  ClaudeConfigView,
  ClaudeConnectionHistoryEntry,
  ClaudeProjectState,
} from '../../../shared/contracts';
import { requiredElement } from '../../platform/dom';
import { createCurrentConnectionSummary } from './current-connection-summary';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';

const currentConnection = requiredElement<HTMLElement>('#current-connection');
const currentConnectionName = requiredElement<HTMLElement>('#current-connection-name');
const currentConnectionMetadata = requiredElement<HTMLElement>('#current-connection-metadata');

const visibleBaseUrl = (config: ClaudeConfigView): string =>
  (config.sourceBaseUrl ?? config.baseUrl).trim();

const visibleModel = (config: ClaudeConfigView): string =>
  (config.sourceModel ?? config.model).trim();

const historyMatchesConfig = (
  entry: ClaudeConnectionHistoryEntry,
  config: ClaudeConfigView,
): boolean =>
  entry.preset === config.preset &&
  (entry.sourceBaseUrl ?? entry.baseUrl).trim() === visibleBaseUrl(config) &&
  (entry.sourceModel ?? entry.model).trim() === visibleModel(config) &&
  (entry.sourceAuthMode ?? entry.authMode) === (config.sourceAuthMode ?? config.authMode);

const matchingHistoryName = (
  entries: readonly ClaudeConnectionHistoryEntry[],
  config: ClaudeConfigView,
): string | undefined => entries.find((entry) => historyMatchesConfig(entry, config))?.name;

const renderEmpty = (): void => {
  currentConnection.dataset.kind = 'empty';
  currentConnectionName.textContent = '尚未选择接入';
  currentConnectionMetadata.textContent = '打开项目后，这里会显示当前生效的账号、模型或中转站。';
};

export interface CurrentConnectionViewActions {
  render: (projectState?: ClaudeProjectState) => void;
}

/** Renders only main-process/project-state truth; late account reads are fenced by generation. */
export const createCurrentConnectionViewActions = (
  dependencies: Pick<
    ConnectionHistoryDependencies,
    'activeClaudeState' | 'getManagedChatGptGatewayState'
  >,
  historyState: ConnectionHistoryState,
): CurrentConnectionViewActions => {
  let generation = 0;

  const applySummary = (projectState: ClaudeProjectState, accountIdentity?: string): void => {
    const summary = createCurrentConnectionSummary(projectState.config, {
      accountIdentity,
      connectionName: matchingHistoryName(historyState.allEntries, projectState.config),
      officialAuth: projectState.officialAuth,
    });
    currentConnection.dataset.kind = summary.kind;
    currentConnectionName.textContent = summary.name;
    currentConnectionMetadata.textContent = summary.metadata.join(' · ');
  };

  const render = (projectState = dependencies.activeClaudeState()): void => {
    const requestGeneration = ++generation;
    if (!projectState) {
      renderEmpty();
      return;
    }

    applySummary(projectState);
    if (projectState.config.preset !== 'chatgpt-subscription') return;

    void dependencies
      .getManagedChatGptGatewayState()
      .then((managedState) => {
        if (requestGeneration !== generation) return;
        const activeState = dependencies.activeClaudeState();
        if (!activeState || activeState.sessionId !== projectState.sessionId) return;
        applySummary(activeState, managedState.accountEmail);
      })
      .catch(() => {
        // The already-rendered "账号信息暂不可用" state is the truthful fallback.
      });
  };

  return { render };
};
