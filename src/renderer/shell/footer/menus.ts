import type {
  ClaudePermissionMode,
  ClaudeProjectState,
  CodexProjectState,
} from '../../../shared/contracts';
import { createFooterMenusContextWindowActions } from './menus-context-window';
import { createFooterMenusFormatActions } from './menus-format';
import { createFooterMenusFrameworkActions } from './menus-framework';
import { createFooterMenusLabelActions } from './menus-labels';
import { createFooterMenusResourceActions } from './menus-resource';

export type { FooterMenusDeps } from './menus-dependencies';
import type { FooterMenusDeps } from './menus-dependencies';

export interface FooterMenus {
  permissionModeCatalog: ReadonlyArray<{
    detail: string;
    id: ClaudePermissionMode;
    label: string;
    needsRelaunch: boolean;
  }>;
  permissionModeLabel: (mode?: ClaudePermissionMode) => string;
  modelSpeedFastLabel: (state: ClaudeProjectState) => string;
  modelSpeedFooterLabel: (state: ClaudeProjectState) => string;
  hideFooterMenus: () => void;
  setFooterSecondaryOpen: (open: boolean) => void;
  openFooterMenu: (menu: HTMLElement, trigger: HTMLButtonElement) => void;
  buildFooterMenuItem: (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled?: boolean,
    triggerButton?: HTMLButtonElement,
  ) => HTMLButtonElement;
  buildFooterRadioMenuItem: (
    label: string,
    detail: string,
    selected: boolean,
    onChoose: () => Promise<void>,
    disabled?: boolean,
    triggerButton?: HTMLButtonElement,
  ) => HTMLButtonElement;
  formatResourceAmount: (amount: number, currency: string) => string;
  formatResetTime: (resetsAt: number | undefined) => string;
  resourceSourceLabel: (
    source: NonNullable<ClaudeProjectState['resourceUsage']>['source'],
  ) => string;
  managedContextWindowSelectable: (
    state: ClaudeProjectState | undefined,
    selectedModel?: string,
  ) => boolean;
  syncManagedChatGptContextWindowSelection: () => void;
  syncClaudeContextWindowSelection: () => void;
  requestedClaudeContextWindowTokens: () => number | undefined;
  renderClaudeContextWindowStatus: (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
  ) => void;
  renderFooterResource: (
    usage: ClaudeProjectState['resourceUsage'] | CodexProjectState['resourceUsage'],
    contextWindowSelectable?: boolean,
  ) => void;
}

export const createFooterMenus = (deps: FooterMenusDeps): FooterMenus => {
  const labelActions = createFooterMenusLabelActions();
  const frameworkActions = createFooterMenusFrameworkActions();
  const formatActions = createFooterMenusFormatActions();
  const contextWindowActions = createFooterMenusContextWindowActions();
  const resourceActions = createFooterMenusResourceActions(
    deps,
    formatActions,
    contextWindowActions,
  );

  return {
    permissionModeCatalog: labelActions.permissionModeCatalog,
    permissionModeLabel: labelActions.permissionModeLabel,
    modelSpeedFastLabel: labelActions.modelSpeedFastLabel,
    modelSpeedFooterLabel: labelActions.modelSpeedFooterLabel,
    hideFooterMenus: frameworkActions.hideFooterMenus,
    setFooterSecondaryOpen: frameworkActions.setFooterSecondaryOpen,
    openFooterMenu: frameworkActions.openFooterMenu,
    buildFooterMenuItem: frameworkActions.buildFooterMenuItem,
    buildFooterRadioMenuItem: frameworkActions.buildFooterRadioMenuItem,
    formatResourceAmount: formatActions.formatResourceAmount,
    formatResetTime: formatActions.formatResetTime,
    resourceSourceLabel: formatActions.resourceSourceLabel,
    managedContextWindowSelectable: contextWindowActions.managedContextWindowSelectable,
    syncManagedChatGptContextWindowSelection:
      contextWindowActions.syncManagedChatGptContextWindowSelection,
    syncClaudeContextWindowSelection: contextWindowActions.syncClaudeContextWindowSelection,
    requestedClaudeContextWindowTokens: contextWindowActions.requestedClaudeContextWindowTokens,
    renderClaudeContextWindowStatus: resourceActions.renderClaudeContextWindowStatus,
    renderFooterResource: resourceActions.renderFooterResource,
  };
};
