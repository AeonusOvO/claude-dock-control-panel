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
  networkPreflightEnvironment: HTMLElement;
  networkPreflightPaths: HTMLUListElement;
  networkPreflightProbes: HTMLElement;
  networkPreflightProvider: HTMLElement;
  networkPreflightReasons: HTMLUListElement;
  networkPreflightRecheck: HTMLButtonElement;
  networkPreflightSummary: HTMLElement;
  networkPreflightTrigger: HTMLButtonElement;
  settingsNetworkFacts: HTMLElement;
  settingsNetworkIssues: HTMLElement;
  settingsNetworkMeta: HTMLElement;
  settingsNetworkRecheck: HTMLButtonElement;
  settingsNetworkStatus: HTMLElement;
  settingsNetworkSummary: HTMLElement;
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
  networkPreflightEnvironment: requiredElement('#network-preflight-environment'),
  networkPreflightPaths: requiredElement('#network-preflight-paths'),
  networkPreflightProbes: requiredElement('#network-preflight-probes'),
  networkPreflightProvider: requiredElement('#network-preflight-provider'),
  networkPreflightReasons: requiredElement('#network-preflight-reasons'),
  networkPreflightRecheck: requiredElement('#network-preflight-recheck'),
  networkPreflightSummary: requiredElement('#network-preflight-summary'),
  networkPreflightTrigger: requiredElement('#network-preflight-trigger'),
  settingsNetworkFacts: requiredElement('#settings-network-facts'),
  settingsNetworkIssues: requiredElement('#settings-network-issues'),
  settingsNetworkMeta: requiredElement('#settings-network-meta'),
  settingsNetworkRecheck: requiredElement('#settings-network-recheck'),
  settingsNetworkStatus: requiredElement('#settings-network-status'),
  settingsNetworkSummary: requiredElement('#settings-network-summary'),
});
