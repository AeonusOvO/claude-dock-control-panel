import type {
  ClaudePreset,
  ClaudeProjectState,
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  DevelopmentRuntimeState,
  SaveClaudeConfigInput,
  SaveClaudeRouterProviderInput,
  TerminalStatus,
} from '../../../shared/contracts';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { AdvancedConnectionSnapshot } from './state';

export interface ConnectionActionsDependencies {
  activeStatus: () => TerminalStatus | undefined;
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void;
  cancelConnectionAdvancedButton: HTMLButtonElement;
  captureAdvancedConnectionSnapshot: () => AdvancedConnectionSnapshot;
  claudeAuthMode: HTMLSelectElement;
  claudeBaseUrl: HTMLInputElement;
  claudeConfigForm: HTMLFormElement;
  claudeCredential: HTMLInputElement;
  claudeModel: HTMLInputElement;
  claudeModelFast: HTMLInputElement;
  claudePreset: HTMLSelectElement;
  clearProviderSelection: (clearDraft?: boolean) => void;
  closeConnectionAdvancedButton: HTMLButtonElement;
  closeRailPreview: () => void;
  completeConnectionAdvancedButton: HTMLButtonElement;
  connectionAdvancedDialog: HTMLDialogElement;
  connectionAdvice: HTMLElement;
  connectionRemedyActions: HTMLElement;
  credentialField: HTMLElement;
  currentConfigInput: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => SaveClaudeConfigInput;
  environmentSetup: HTMLElement;
  getActiveSessionId: () => string;
  getClaudeState: (sessionId: string) => ClaudeProjectState | undefined;
  getDevelopmentRuntime: (sessionId: string) => DevelopmentRuntimeState | undefined;
  getSelectedProviderId: () => ClaudeProviderId | undefined;
  getSelectedRailTab: () => string | undefined;
  importCurlRouterButton: HTMLButtonElement;
  installRouterButton: HTMLButtonElement;
  loadClaudeState: (sessionId: string) => Promise<void>;
  openConnectionAdvancedButton: HTMLButtonElement;
  openExternal: (url: string) => Promise<void>;
  providerPicker: HTMLElement;
  proxy: {
    beginDialogLoad: () => number;
    completeDialogLoad: (loadGeneration: number, loaded: boolean) => boolean;
    endDialogSession: (restore: boolean) => void;
    loadState: (preserveDirtyDraft?: boolean, loadGeneration?: number) => Promise<boolean>;
  };
  renderClaudeState: (
    state: ClaudeProjectState,
    observeLaunch?: boolean,
    invalidatePendingLoad?: boolean,
  ) => void;
  restoreAdvancedConnectionSnapshot: (snapshot: AdvancedConnectionSnapshot) => void;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  router: {
    getManagementState: () => ClaudeRouterManagementState | undefined;
    isOperationInProgress: () => boolean;
    loadManagement: () => Promise<void>;
    renderRouterManagement: (managementState: ClaudeRouterManagementState) => void;
    runOperation: (
      action: (sessionId: string) => Promise<ClaudeRouterOperationResult>,
      busyLabel: string,
      button: HTMLButtonElement,
    ) => Promise<void>;
    runRouterProviderSave: (input: SaveClaudeRouterProviderInput) => Promise<boolean>;
    uninstallRouterCli: (button: HTMLButtonElement) => Promise<void>;
  };
  runGuarded: <T>(
    button: HTMLButtonElement,
    busyLabel: string,
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
  savedClaudeConfigInput: (config: ClaudeProjectState['config']) => SaveClaudeConfigInput;
  saveClaudeConfig: (
    credentialAction: SaveClaudeConfigInput['credentialAction'],
  ) => Promise<boolean>;
  selectRailTab: (tab: string) => void;
  setAuthOptions: (
    options: Array<{ label: string; value: SaveClaudeConfigInput['authMode'] }>,
    selected?: SaveClaudeConfigInput['authMode'],
  ) => void;
  settings: {
    endDialogSession: (restore: boolean) => void;
    loadAppSettings: () => Promise<void>;
    savePending: () => Promise<void>;
    selectGeneralTab: () => void;
    updateUnsavedIndicator: () => number;
  };
  showToast: (message: string, tone?: 'error' | 'success') => void;
  startRouterButton: HTMLButtonElement;
  syncApiKeyHelperPolicyUi: () => void;
  syncConnectionInteractivity: () => void;
  updates: {
    applyRouterRelevance: () => void;
    loadSoftwareUpdates: (refresh?: boolean) => Promise<void>;
    runClaudeInstallUpdate: () => Promise<void>;
  };
}
