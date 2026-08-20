import { requiredElement } from '../../platform/dom';

export interface PreflightElements {
  networkPreflightCard: HTMLElement;
  networkPreflightClearHistory: HTMLButtonElement;
  networkPreflightClose: HTMLButtonElement;
  networkPreflightDetails: HTMLButtonElement;
  networkPreflightDialog: HTMLDialogElement;
  networkPreflightDialogMeta: HTMLElement;
  networkPreflightDialogRecheck: HTMLButtonElement;
  networkPreflightDialogSummary: HTMLElement;
  networkPreflightDialogTone: HTMLElement;
  networkPreflightPaths: HTMLUListElement;
  networkPreflightProbes: HTMLElement;
  networkPreflightProvider: HTMLElement;
  networkPreflightReasons: HTMLUListElement;
  networkPreflightRecheck: HTMLButtonElement;
  networkPreflightSummary: HTMLElement;
}

export const createPreflightElements = (): PreflightElements => ({
  networkPreflightCard: requiredElement('#network-preflight-card'),
  networkPreflightClearHistory: requiredElement('#network-preflight-clear-history'),
  networkPreflightClose: requiredElement('#network-preflight-close'),
  networkPreflightDetails: requiredElement('#network-preflight-details'),
  networkPreflightDialog: requiredElement('#network-preflight-dialog'),
  networkPreflightDialogMeta: requiredElement('#network-preflight-dialog-meta'),
  networkPreflightDialogRecheck: requiredElement('#network-preflight-dialog-recheck'),
  networkPreflightDialogSummary: requiredElement('#network-preflight-dialog-summary'),
  networkPreflightDialogTone: requiredElement('.network-preflight-dialog__summary'),
  networkPreflightPaths: requiredElement('#network-preflight-paths'),
  networkPreflightProbes: requiredElement('#network-preflight-probes'),
  networkPreflightProvider: requiredElement('#network-preflight-provider'),
  networkPreflightReasons: requiredElement('#network-preflight-reasons'),
  networkPreflightRecheck: requiredElement('#network-preflight-recheck'),
  networkPreflightSummary: requiredElement('#network-preflight-summary'),
});
