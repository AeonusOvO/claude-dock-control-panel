import type { RailMutableState } from './rail-state';

export interface RailPreviewActions {
  cancelRailPreviewClose: () => void;
  closeRailPreview: () => void;
  dispose: () => void;
  escapeRailPreview: () => boolean;
  scheduleRailPreviewClose: (delay?: number) => void;
  showRailPreview: (tab: string) => void;
}

export const createRailPreviewActions = (
  state: RailMutableState,
  activityRail: HTMLElement,
  controlPanel: HTMLElement,
  prepareRailTab: (tab: string) => void,
  renderRailPresentation: (tab: string | undefined, preview: boolean) => void,
): RailPreviewActions => {
  const cancelRailPreviewClose = (): void => {
    window.clearTimeout(state.railPreviewCloseTimer);
    state.railPreviewCloseTimer = undefined;
  };

  const closeRailPreview = (): void => {
    cancelRailPreviewClose();
    if (state.previewRailTab === undefined) return;
    state.previewRailTab = undefined;
    renderRailPresentation(state.selectedRailTab, false);
  };

  const railPreviewDialogObserver = new MutationObserver((records) => {
    if (
      state.previewRailTab !== undefined &&
      records.some(
        ({ target }) => target instanceof HTMLDialogElement && target.hasAttribute('open'),
      )
    ) {
      closeRailPreview();
    }
  });
  railPreviewDialogObserver.observe(document.body, {
    attributeFilter: ['open'],
    attributes: true,
    subtree: true,
  });

  const scheduleRailPreviewClose = (delay = 120): void => {
    cancelRailPreviewClose();
    state.railPreviewCloseTimer = window.setTimeout(closeRailPreview, delay);
  };

  const showRailPreview = (tab: string): void => {
    if (state.selectedRailTab !== undefined) return;
    cancelRailPreviewClose();
    if (state.previewRailTab !== tab) prepareRailTab(tab);
    state.previewRailTab = tab;
    renderRailPresentation(tab, true);
  };

  const escapeRailPreview = (): boolean => {
    if (state.previewRailTab === undefined) return false;
    const trigger = activityRail.querySelector<HTMLButtonElement>(
      `[data-rail-tab="${state.previewRailTab}"]`,
    );
    closeRailPreview();
    trigger?.focus();
    return true;
  };

  controlPanel.addEventListener('pointerenter', cancelRailPreviewClose);
  controlPanel.addEventListener('pointerleave', () => scheduleRailPreviewClose());
  controlPanel.addEventListener('focusin', cancelRailPreviewClose);
  controlPanel.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && (controlPanel.contains(next) || activityRail.contains(next))) return;
    scheduleRailPreviewClose(0);
  });

  return {
    cancelRailPreviewClose,
    closeRailPreview,
    dispose: () => {
      railPreviewDialogObserver.disconnect();
    },
    escapeRailPreview,
    scheduleRailPreviewClose,
    showRailPreview,
  };
};
