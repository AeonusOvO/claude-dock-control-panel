import { requiredElement } from '../../platform/dom';

export interface ArtifactElements {
  activeList: HTMLElement;
  detailsButton: HTMLButtonElement;
  detailsClose: HTMLButtonElement;
  detailsPanel: HTMLElement;
  detailsScrim: HTMLElement;
  networkAllowed: HTMLInputElement;
  networkLog: HTMLOListElement;
}

export const createArtifactElements = (): ArtifactElements => ({
  activeList: requiredElement('#artifact-active-list'),
  detailsButton: requiredElement('#chat-artifact-details'),
  detailsClose: requiredElement('#artifact-details-close'),
  detailsPanel: requiredElement('#artifact-details-panel'),
  detailsScrim: requiredElement('#artifact-details-scrim'),
  networkAllowed: requiredElement('#artifact-network-allowed'),
  networkLog: requiredElement('#artifact-network-log'),
});
