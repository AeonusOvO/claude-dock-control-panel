import type {
  ClaudeContextWindowMode,
  ClaudeEffortRequest,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudeProjectState,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
  ModelSpeedMode,
} from '../../../shared/contracts';
import type { FooterMenus } from './menus';
import { createFooterSwitchesChipsActions } from './switches-chips';
import { createFooterSwitchesEffortActions } from './switches-effort';
import { createFooterSwitchesMenusActions } from './switches-menus';
import { createFooterSwitchesModeActions } from './switches-mode';
import { createFooterSwitchesModelActions } from './switches-model';
import { createFooterSwitchesPreferencesActions } from './switches-preferences';
import type { FooterSwitchesDeps } from './switches-dependencies';

export type { FooterSwitchesDeps } from './switches-dependencies';

export interface FooterSwitches {
  renderTerminalFooterChips: (state: ClaudeProjectState) => void;
  switchClaudeModel: (option: ClaudeModelOption) => Promise<void>;
  switchClaudeModelSpeed: (mode: ModelSpeedMode) => Promise<void>;
  switchPermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
  switchEffortLevel: (effort: ClaudeEffortRequest) => Promise<void>;
  openModelMenu: (trigger?: HTMLButtonElement) => Promise<void>;
  openSpeedMenu: () => void;
  openModeMenu: () => void;
  openEffortMenu: () => void;
  applyClaudeContextWindowMode: (mode: ClaudeContextWindowMode, customTokens?: number) => void;
  applyManagedChatGptContextWindowMode: (mode: ManagedChatGptContextWindowMode) => void;
  applyFooterResourcePreference: (preference: FooterResourcePreference) => void;
}

export const createFooterSwitches = (
  menus: FooterMenus,
  deps: FooterSwitchesDeps,
): FooterSwitches => {
  const chipsActions = createFooterSwitchesChipsActions(deps, menus);
  const modelActions = createFooterSwitchesModelActions(deps, menus);
  const modeActions = createFooterSwitchesModeActions(deps);
  const effortActions = createFooterSwitchesEffortActions(deps, menus);
  const menusActions = createFooterSwitchesMenusActions(
    deps,
    menus,
    modelActions.switchClaudeModel,
    modelActions.switchClaudeModelSpeed,
    modeActions.switchPermissionMode,
  );
  const preferencesActions = createFooterSwitchesPreferencesActions(deps, menus);

  return {
    renderTerminalFooterChips: chipsActions.renderTerminalFooterChips,
    switchClaudeModel: modelActions.switchClaudeModel,
    switchClaudeModelSpeed: modelActions.switchClaudeModelSpeed,
    switchPermissionMode: modeActions.switchPermissionMode,
    switchEffortLevel: effortActions.switchEffortLevel,
    openModelMenu: menusActions.openModelMenu,
    openSpeedMenu: menusActions.openSpeedMenu,
    openModeMenu: menusActions.openModeMenu,
    openEffortMenu: effortActions.openEffortMenu,
    applyClaudeContextWindowMode: preferencesActions.applyClaudeContextWindowMode,
    applyManagedChatGptContextWindowMode: preferencesActions.applyManagedChatGptContextWindowMode,
    applyFooterResourcePreference: preferencesActions.applyFooterResourcePreference,
  };
};
