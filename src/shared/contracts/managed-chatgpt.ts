import type { FailureMetadata } from '../diagnostics/failure';
import type { ClaudeConnectionTestResult, ClaudeProjectState } from './claude';

export type ManagedChatGptGatewayPhase =
  'installing' | 'login-required' | 'not-installed' | 'ready' | 'stopped';

/**
 * Public state for the ClaudeDock-owned CLIProxyAPI sidecar. OAuth files and the generated local
 * access key never cross the main/renderer boundary.
 */
export interface ManagedChatGptGatewayState {
  /** Validated account identity for the current local OAuth artifact; tokens never cross IPC. */
  accountEmail?: string;
  availableModels: string[];
  authenticated: boolean;
  busy: boolean;
  checkedAt: number;
  endpoint: string;
  installed: boolean;
  managementAvailable: boolean;
  message: string;
  phase: ManagedChatGptGatewayPhase;
  running: boolean;
  usageStatisticsEnabled: false;
  version?: string;
}

export interface ManagedChatGptGatewayOperationResult extends FailureMetadata {
  connectionTest?: ClaudeConnectionTestResult;
  error?: string;
  message: string;
  ok: boolean;
  projectState?: ClaudeProjectState;
  state: ManagedChatGptGatewayState;
}

export type ManagedChatGptSetupStage =
  | 'complete'
  | 'detecting'
  | 'discovering-models'
  | 'error'
  | 'installing-claude'
  | 'installing-gateway'
  | 'logging-in'
  | 'saving'
  | 'testing';

export interface ManagedChatGptSetupProgress {
  active: boolean;
  detail: string;
  interruptible: boolean;
  sessionId?: string;
  stage: ManagedChatGptSetupStage;
  step: number;
  totalSteps: number;
}
