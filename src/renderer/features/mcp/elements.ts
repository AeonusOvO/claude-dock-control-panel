import { requiredElement } from '../../platform/dom';

export interface McpElements {
  backupRestore: HTMLButtonElement;
  backupSelect: HTMLSelectElement;
  catalogCount: HTMLElement;
  catalogList: HTMLElement;
  installScope: HTMLSelectElement;
  installedCount: HTMLElement;
  installedList: HTMLElement;
  refresh: HTMLButtonElement;
  scopeFilter: HTMLSelectElement;
  search: HTMLInputElement;
  status: HTMLElement;
}

export const createMcpElements = (): McpElements => ({
  backupRestore: requiredElement('#mcp-backup-restore'),
  backupSelect: requiredElement('#mcp-backup-select'),
  catalogCount: requiredElement('#mcp-catalog-count'),
  catalogList: requiredElement('#mcp-catalog-list'),
  installScope: requiredElement('#mcp-install-scope'),
  installedCount: requiredElement('#mcp-installed-count'),
  installedList: requiredElement('#mcp-installed-list'),
  refresh: requiredElement('#mcp-refresh'),
  scopeFilter: requiredElement('#mcp-scope-filter'),
  search: requiredElement('#mcp-search'),
  status: requiredElement('#mcp-status'),
});
