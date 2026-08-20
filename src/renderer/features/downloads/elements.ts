import { requiredElement } from '../../platform/dom';

export interface DownloadsElements {
  activeCount: HTMLElement;
  activeSection: HTMLElement;
  activeSummary: HTMLElement;
  centerDialog: HTMLDialogElement;
  centerEmpty: HTMLElement;
  clearHistoryButton: HTMLButtonElement;
  closeCenterButton: HTMLButtonElement;
  historyList: HTMLElement;
  historySection: HTMLElement;
  historySummary: HTMLElement;
  openCenterButton: HTMLButtonElement;
  operationList: HTMLElement;
  progressTemplate: HTMLTemplateElement;
  taskList: HTMLElement;
}

export const createDownloadsElements = (): DownloadsElements => ({
  activeCount: requiredElement('#download-active-count'),
  activeSection: requiredElement('#download-active-section'),
  activeSummary: requiredElement('#download-active-summary'),
  centerDialog: requiredElement('#download-center-dialog'),
  centerEmpty: requiredElement('#download-center-empty'),
  clearHistoryButton: requiredElement('#clear-download-history'),
  closeCenterButton: requiredElement('#close-download-center'),
  historyList: requiredElement('#download-history-list'),
  historySection: requiredElement('#download-history-section'),
  historySummary: requiredElement('#download-history-summary'),
  openCenterButton: requiredElement('#open-download-center'),
  operationList: requiredElement('#download-operation-list'),
  progressTemplate: requiredElement('#download-progress-template'),
  taskList: requiredElement('#download-task-list'),
});
