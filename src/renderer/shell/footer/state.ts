import type {
  ClaudeContextWindowMode,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
} from '../../../shared/contracts';

export interface FooterMutableState {
  claudeContextWindowCustomDraftOpen: boolean;
  claudeContextWindowCustomTokens: number | undefined;
  claudeContextWindowMode: ClaudeContextWindowMode;
  effortSwitchInProgress: boolean;
  footerResourcePreference: FooterResourcePreference;
  managedChatGptContextWindowMode: ManagedChatGptContextWindowMode;
  modeSwitchInProgress: boolean;
  modelSwitchInProgress: boolean;
}

export const footerState: FooterMutableState = {
  claudeContextWindowCustomDraftOpen: false,
  claudeContextWindowCustomTokens: undefined,
  claudeContextWindowMode: 'auto',
  effortSwitchInProgress: false,
  footerResourcePreference: 'auto',
  managedChatGptContextWindowMode: 'standard',
  modeSwitchInProgress: false,
  modelSwitchInProgress: false,
};
