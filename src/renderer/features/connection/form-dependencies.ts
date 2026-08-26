import type { ClaudeGatewayDiagnostics, SaveClaudeConfigInput } from '../../../shared/contracts';
import type { ConfirmationRequest } from '../../shell/dialogs';

export interface ConnectionFormDeps {
  runGuarded: <T>(
    button: HTMLButtonElement,
    busyLabel: string,
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  connectionFeature: {
    clearTestResult: () => void;
    runConnectionTest: (
      saveOnSuccess?: boolean,
      configInput?: SaveClaudeConfigInput,
    ) => Promise<void>;
    getDiagnostics: () => ClaudeGatewayDiagnostics | undefined;
    isTestInProgress: () => boolean;
    isRemedyInProgress: () => boolean;
  };
  renderNextConnection: () => void;
}
