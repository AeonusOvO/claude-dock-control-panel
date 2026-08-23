import { requiredElement } from '../../platform/dom';

export const footerConnection = requiredElement<HTMLButtonElement>('#footer-connection');
export const footerConnectionLabel = requiredElement<HTMLElement>('#footer-connection-label');
export const footerContextLabel = requiredElement<HTMLElement>('#footer-context-label');
export const footerContextRing = requiredElement<HTMLElement>('#footer-context-ring');
export const footerResource = requiredElement<HTMLButtonElement>('#footer-resource');
export const footerResourceMenu = requiredElement<HTMLElement>('#footer-resource-menu');
export const footerResourceDetails = requiredElement<HTMLElement>('#footer-resource-details');
export const footerContextWindowOptions = requiredElement<HTMLElement>(
  '#footer-context-window-options',
);
export const claudeContextWindowOptions = requiredElement<HTMLElement>(
  '#claude-context-window-options',
);
export const claudeContextWindowCustomField = requiredElement<HTMLElement>(
  '#claude-context-window-custom-field',
);
export const claudeContextWindowCustomInput = requiredElement<HTMLInputElement>(
  '#claude-context-window-custom-input',
);
export const claudeContextWindowStatus = requiredElement<HTMLElement>(
  '#claude-context-window-status',
);
export const footerModel = requiredElement<HTMLButtonElement>('#footer-model');
export const footerModelMenu = requiredElement<HTMLElement>('#footer-model-menu');
export const footerSpeed = requiredElement<HTMLButtonElement>('#footer-speed');
export const footerSpeedMenu = requiredElement<HTMLElement>('#footer-speed-menu');
export const footerMode = requiredElement<HTMLButtonElement>('#footer-mode');
export const footerModeMenu = requiredElement<HTMLElement>('#footer-mode-menu');
export const footerEffort = requiredElement<HTMLButtonElement>('#footer-effort');
export const footerEffortMenu = requiredElement<HTMLElement>('#footer-effort-menu');
export const footerSessionSettings = requiredElement<HTMLButtonElement>('#footer-session-settings');
export const footerSessionSettingsRegion = requiredElement<HTMLElement>(
  '#footer-session-settings-region',
);
export const footerStatus = requiredElement<HTMLElement>('#footer-status');
