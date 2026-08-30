import { requiredElement } from '../../platform/dom';

export interface UpdatesElements {
  applicationUpdateAction: HTMLButtonElement;
  applicationUpdateDetail: HTMLElement;
  applicationUpdateVersion: HTMLElement;
  cancelUpdateCenterButton: HTMLButtonElement;
  claudeInstallActions: HTMLElement;
  claudeUpdateDetail: HTMLElement;
  claudeUpdateVersion: HTMLElement;
  closeUpdateCenterButton: HTMLButtonElement;
  installUpdateClaudeButton: HTMLButtonElement;
  refreshSoftwareUpdatesButton: HTMLButtonElement;
  refreshUpdatesButton: HTMLButtonElement;
  softwareUpdateCheckedAt: HTMLElement;
  updateCenterAllButton: HTMLButtonElement;
  updateCenterDialog: HTMLDialogElement;
  updateCenterEmpty: HTMLElement;
  updateCenterHistoryEmpty: HTMLElement;
  updateCenterHistoryList: HTMLElement;
  updateCenterHistoryTab: HTMLButtonElement;
  updateCenterList: HTMLElement;
  updateCenterPendingPanel: HTMLElement;
  updateCenterPendingTab: HTMLButtonElement;
  updateCenterSummary: HTMLElement;
}

export const createUpdatesElements = (): UpdatesElements => ({
  applicationUpdateAction: requiredElement('#application-update-action'),
  applicationUpdateDetail: requiredElement('#application-update-detail'),
  applicationUpdateVersion: requiredElement('#application-update-version'),
  cancelUpdateCenterButton: requiredElement('#cancel-update-center'),
  claudeInstallActions: requiredElement('#claude-install-actions'),
  claudeUpdateDetail: requiredElement('#claude-update-detail'),
  claudeUpdateVersion: requiredElement('#claude-update-version'),
  closeUpdateCenterButton: requiredElement('#close-update-center'),
  installUpdateClaudeButton: requiredElement('#install-update-claude'),
  refreshSoftwareUpdatesButton: requiredElement('#refresh-software-updates'),
  refreshUpdatesButton: requiredElement('#refresh-updates'),
  softwareUpdateCheckedAt: requiredElement('#software-update-checked-at'),
  updateCenterAllButton: requiredElement('#update-center-all'),
  updateCenterDialog: requiredElement('#update-center-dialog'),
  updateCenterEmpty: requiredElement('#update-center-empty'),
  updateCenterHistoryEmpty: requiredElement('#update-center-history-empty'),
  updateCenterHistoryList: requiredElement('#update-center-history-list'),
  updateCenterHistoryTab: requiredElement('#update-center-history-tab'),
  updateCenterList: requiredElement('#update-center-list'),
  updateCenterPendingPanel: requiredElement('#update-center-pending-panel'),
  updateCenterPendingTab: requiredElement('#update-center-pending-tab'),
  updateCenterSummary: requiredElement('#update-center-summary'),
});
