import { requiredElement } from '../../platform/dom';

export interface PluginsElements {
  addMarketplaceButton: HTMLButtonElement;
  availableCount: HTMLElement;
  availableList: HTMLElement;
  categoryFilter: HTMLSelectElement;
  installedCount: HTMLElement;
  installedList: HTMLElement;
  marketplaceForm: HTMLFormElement;
  marketplaceList: HTMLElement;
  marketplaceSource: HTMLInputElement;
  railDot: HTMLElement;
  refreshButton: HTMLButtonElement;
  search: HTMLInputElement;
  status: HTMLElement;
  updateActions: HTMLElement;
  updateAllButton: HTMLButtonElement;
}

export const createPluginsElements = (): PluginsElements => ({
  addMarketplaceButton: requiredElement('#add-plugin-marketplace'),
  availableCount: requiredElement('#plugin-available-count'),
  availableList: requiredElement('#plugin-available-list'),
  categoryFilter: requiredElement('#plugin-category-filter'),
  installedCount: requiredElement('#plugin-installed-count'),
  installedList: requiredElement('#plugin-installed-list'),
  marketplaceForm: requiredElement('#plugin-marketplace-form'),
  marketplaceList: requiredElement('#plugin-marketplace-list'),
  marketplaceSource: requiredElement('#plugin-marketplace-source'),
  railDot: requiredElement('#plugin-rail-dot'),
  refreshButton: requiredElement('#refresh-plugins'),
  search: requiredElement('#plugin-search'),
  status: requiredElement('#plugin-status'),
  updateActions: requiredElement('#plugin-update-actions'),
  updateAllButton: requiredElement('#update-all-plugins'),
});
