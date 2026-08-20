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
  updateCenterList: HTMLElement;
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
  updateCenterList: requiredElement('#update-center-list'),
  updateCenterSummary: requiredElement('#update-center-summary'),
});
