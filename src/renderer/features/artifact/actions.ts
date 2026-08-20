import type { ArtifactNetworkLogEntry } from '../../../shared/contracts';
import { closeOpenSelect } from '../../platform/components';
import { ArtifactController } from '../../platform/artifact';
import type { ArtifactElements } from './elements';
import type { ArtifactState } from './state';
import type { ArtifactView } from './view';

export interface ArtifactActionsDependencies {
  setChatInert: (open: boolean) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface ArtifactActions {
  bind: () => () => void;
  hasActiveArtifacts: () => boolean;
  run: (html: string, mount: HTMLElement) => Promise<string>;
  setDetailsOpen: (open: boolean) => void;
  stopAll: () => void;
  updateTheme: () => void;
}

interface ArtifactActionsContext {
  controller?: ArtifactController;
  dependencies: ArtifactActionsDependencies;
  elements: ArtifactElements;
  state: ArtifactState;
  view: ArtifactView;
}

const renderArtifactActiveList = (context: ArtifactActionsContext): void => {
  const { controller, elements } = context;
  elements.activeList.replaceChildren();
  const ids = controller?.activeIds() ?? [];
  if (ids.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'artifact-details__empty';
    empty.textContent = '当前没有正在运行的可视化。';
    elements.activeList.append(empty);
    return;
  }
  for (const [index, artifactId] of ids.entries()) {
    const row = document.createElement('div');
    row.className = 'artifact-active-list__item';
    const copy = document.createElement('span');
    copy.textContent = `可视化 ${index + 1}`;
    copy.title = artifactId;
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '停止运行';
    stop.addEventListener('click', () => {
      void controller?.stop(artifactId);
    });
    row.append(copy, stop);
    elements.activeList.append(row);
  }
};

const setArtifactDetailsOpen = (context: ArtifactActionsContext, open: boolean): void => {
  const { dependencies, elements, state, view } = context;
  closeOpenSelect();
  elements.detailsButton.setAttribute('aria-expanded', String(open));
  elements.detailsPanel.setAttribute('aria-hidden', String(!open));
  elements.detailsPanel.dataset.open = String(open);
  elements.detailsPanel.inert = !open;
  dependencies.setChatInert(open);
  elements.detailsScrim.hidden = !open;
  if (open) {
    void window.controlPanel
      .getArtifactNetworkState()
      .then((networkState) => {
        state.network = networkState;
        view.renderNetworkLog();
      })
      .catch(() => {
        dependencies.showToast('无法读取 Artifact 审计信息。', 'error');
      });
    renderArtifactActiveList(context);
    elements.detailsClose.focus();
  } else {
    elements.detailsButton.focus();
  }
};

const bindArtifactActions = (context: ArtifactActionsContext): (() => void) => {
  const { dependencies, elements, state, view } = context;
  const handleDetailsToggle = (): void => {
    setArtifactDetailsOpen(
      context,
      elements.detailsButton.getAttribute('aria-expanded') !== 'true',
    );
  };
  const handleDetailsClose = (): void => {
    setArtifactDetailsOpen(context, false);
  };
  const handleNetworkAllowedChange = (): void => {
    elements.networkAllowed.disabled = true;
    void window.controlPanel
      .setArtifactNetworkAllowed(elements.networkAllowed.checked)
      .then((networkState) => {
        state.network = networkState;
        view.renderNetworkLog();
        dependencies.showToast(
          networkState.allowed ? 'Artifact 联网已开启' : 'Artifact 联网已关闭',
        );
      })
      .catch(() => {
        elements.networkAllowed.checked = state.network.allowed;
        dependencies.showToast('无法保存 Artifact 联网设置。', 'error');
      })
      .finally(() => {
        elements.networkAllowed.disabled = false;
      });
  };
  const handleNetworkLogEntry = (entry: ArtifactNetworkLogEntry): void => {
    const existing = state.network.entries.findIndex((candidate) => candidate.id === entry.id);
    if (existing >= 0) {
      state.network.entries.splice(existing, 1, entry);
    } else {
      state.network.entries.push(entry);
    }
    if (state.network.entries.length > 500) {
      state.network.entries.splice(0, state.network.entries.length - 500);
    }
    view.renderNetworkLog();
  };

  elements.detailsButton.addEventListener('click', handleDetailsToggle);
  elements.detailsClose.addEventListener('click', handleDetailsClose);
  elements.detailsScrim.addEventListener('click', handleDetailsClose);
  elements.networkAllowed.addEventListener('change', handleNetworkAllowedChange);
  const unsubscribeNetworkLog = window.controlPanel.onArtifactNetworkLog(handleNetworkLogEntry);

  return () => {
    elements.detailsButton.removeEventListener('click', handleDetailsToggle);
    elements.detailsClose.removeEventListener('click', handleDetailsClose);
    elements.detailsScrim.removeEventListener('click', handleDetailsClose);
    elements.networkAllowed.removeEventListener('change', handleNetworkAllowedChange);
    unsubscribeNetworkLog();
  };
};

export const createArtifactActions = (
  elements: ArtifactElements,
  state: ArtifactState,
  dependencies: ArtifactActionsDependencies,
  view: ArtifactView,
): ArtifactActions => {
  const controller = new ArtifactController({
    create: (html) => window.controlPanel.createArtifact(html),
    destroy: (artifactId) => window.controlPanel.destroyArtifact(artifactId),
    getTheme: view.themePayload,
    onActiveChange: () => renderArtifactActiveList(context),
    onError: (message) => dependencies.showToast(message, 'error'),
  });
  const context: ArtifactActionsContext = { controller, dependencies, elements, state, view };

  return {
    bind: () => bindArtifactActions(context),
    hasActiveArtifacts: () => controller.activeIds().length > 0,
    run: (html, mount) => controller.run(html, mount),
    setDetailsOpen: (open) => setArtifactDetailsOpen(context, open),
    stopAll: () => controller.stopAll(),
    updateTheme: () => controller.updateTheme(),
  };
};
