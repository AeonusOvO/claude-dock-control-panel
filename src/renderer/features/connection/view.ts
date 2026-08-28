import type { SoftwareUpdateState } from '../../../shared/contracts';
import type { ConnectionElements } from './elements';
import type { ConnectionState } from './state';

export interface ConnectionViewDependencies {
  routerActions: HTMLElement;
  routerManager: HTMLElement;
}

export interface ConnectionView {
  applyRouterRelevance: (updates: SoftwareUpdateState | undefined) => void;
  renderConnectionTestPending: () => void;
}

export const createConnectionView = (
  elements: ConnectionElements,
  state: ConnectionState,
  dependencies: ConnectionViewDependencies,
): ConnectionView => {
  const applyRouterRelevance = (updates: SoftwareUpdateState | undefined): void => {
    const advice = state.connectionAdviceState;
    dependencies.routerManager.dataset.relevance = 'active';
    dependencies.routerActions.dataset.relevance = 'active';
    const updateAvailable = updates?.claudeCode.updateAvailable || updates?.router.updateAvailable;
    elements.connectionRailDot.hidden = (!advice || advice.tone === 'success') && !updateAvailable;
    elements.connectionRailDot.dataset.tone = updateAvailable
      ? 'warning'
      : (advice?.tone ?? 'info');
    elements.connectionRailDot.title = updateAvailable
      ? [
          updates?.claudeCode.updateAvailable &&
            `Claude Code ${updates.claudeCode.latestVersion ?? ''}`,
          updates?.router.updateAvailable && `路由器 ${updates.router.latestVersion ?? ''}`,
        ]
          .filter(Boolean)
          .join('、')
      : (advice?.title ?? '');
  };

  const renderConnectionTestPending = (): void => {
    elements.connectionTestResult.hidden = false;
    elements.connectionTestResult.dataset.tone = 'pending';
    elements.connectionTestResult.setAttribute('aria-busy', 'true');
    elements.connectionTestTitle.textContent = '正在连接…';
    elements.connectionTestSummary.textContent = '';
    elements.connectionTestStages.replaceChildren();
  };

  return {
    applyRouterRelevance,
    renderConnectionTestPending,
  };
};
