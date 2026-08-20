import { requiredElement } from '../platform/dom';

export const runtimeActivityTrigger = requiredElement<HTMLButtonElement>(
  '#runtime-activity-trigger',
);
export const runtimeActivityPanel = requiredElement<HTMLElement>('#runtime-activity-panel');
const runtimeActivityClose = requiredElement<HTMLButtonElement>('#runtime-activity-close');

export interface RuntimeActivityPanelActions {
  readonly runtimeActivityTrigger: HTMLButtonElement;
  readonly runtimeActivityPanel: HTMLElement;
  setRuntimeSummaryOpen: (open: boolean, restoreFocus?: boolean) => void;
}

export const createRuntimeActivityPanelActions = (): RuntimeActivityPanelActions => {
  let runtimeSummaryCloseTimer: number | undefined;

  const setRuntimeSummaryOpen = (open: boolean, restoreFocus = false): void => {
    if (runtimeSummaryCloseTimer !== undefined) {
      window.clearTimeout(runtimeSummaryCloseTimer);
      runtimeSummaryCloseTimer = undefined;
    }
    if (open) {
      runtimeActivityPanel.hidden = false;
      runtimeActivityPanel.dataset.state = 'opening';
      runtimeActivityTrigger.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(() => {
        if (runtimeActivityPanel.dataset.state === 'opening') {
          runtimeActivityPanel.dataset.state = 'open';
        }
      });
      runtimeActivityClose.focus({ preventScroll: true });
      return;
    }
    if (runtimeActivityPanel.hidden) return;
    runtimeActivityPanel.dataset.state = 'closing';
    runtimeActivityTrigger.setAttribute('aria-expanded', 'false');
    runtimeSummaryCloseTimer = window.setTimeout(() => {
      runtimeActivityPanel.hidden = true;
      runtimeActivityPanel.dataset.state = 'closed';
      runtimeSummaryCloseTimer = undefined;
      if (restoreFocus) runtimeActivityTrigger.focus({ preventScroll: true });
    }, 220);
  };

  runtimeActivityTrigger.addEventListener('click', () => {
    setRuntimeSummaryOpen(
      Boolean(runtimeActivityPanel.hidden || runtimeActivityPanel.dataset.state === 'closing'),
    );
  });
  runtimeActivityClose.addEventListener('click', () => {
    setRuntimeSummaryOpen(false, true);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !runtimeActivityPanel.hidden) {
      event.preventDefault();
      setRuntimeSummaryOpen(false, true);
    }
  });

  return {
    runtimeActivityTrigger,
    runtimeActivityPanel,
    setRuntimeSummaryOpen,
  };
};
