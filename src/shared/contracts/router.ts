import type { FailureMetadata } from '../diagnostics/failure';
import type { ClaudeProjectState, ClaudeRouterGatewayState } from './claude';

export type ClaudeRouterInstallationKind = 'desktop' | 'mixed' | 'npm' | 'unknown';

/** ClaudeDock only manages the CCR command-line package; desktop installers are out of scope. */
export type ClaudeRouterInstallSource = 'npm' | 'npmmirror';

export type ClaudeRouterProviderProtocol =
  'anthropic_messages' | 'openai_chat_completions' | 'openai_responses';

export interface ClaudeRouterProviderView {
  baseUrl: string;
  credentialConfigured: boolean;
  id: string;
  models: string[];
  name: string;
  preferred: boolean;
  protocol: ClaudeRouterProviderProtocol;
}

export interface ClaudeRouterManagementState {
  canUninstall: boolean;
  checkedAt: number;
  endpoint: string;
  gatewayState: ClaudeRouterGatewayState;
  installed: boolean;
  installationKind: ClaudeRouterInstallationKind;
  manageable: boolean;
  managementAvailable: boolean;
  message: string;
  providers: ClaudeRouterProviderView[];
  runtimeMismatch?: boolean;
  serviceRunning: boolean;
  version?: string;
}

export type RouterOperationKind = 'configure' | 'install' | 'recover' | 'start' | 'stop';

export type RouterOperationStage =
  | 'checking'
  | 'complete'
  | 'configuring'
  | 'downloading'
  | 'error'
  | 'installing'
  | 'recovering'
  | 'starting'
  | 'stopping'
  | 'verifying';

/** A secret-free, main-process-authored snapshot of a long-running router operation. */
export interface RouterOperationProgress {
  active: boolean;
  detail: string;
  operation: RouterOperationKind;
  stage: RouterOperationStage;
  step: number;
  totalSteps: number;
  updatedAt: number;
}

export type RouterKernelId = 'cc-switch' | 'ccr' | 'none';

export interface CcSwitchInstallationState {
  checkedAt: number;
  executable?: string;
  installed: boolean;
  message: string;
  protocolRegistered: boolean;
  residuals: string[];
  running: boolean;
  uninstallable: boolean;
  version?: string;
}

export interface RouterKernelState {
  active: RouterKernelId;
  ccSwitch: CcSwitchInstallationState;
  checkedAt: number;
  conflict: boolean;
  ccr: ClaudeRouterManagementState;
}

export interface RouterKernelOperationResult extends FailureMetadata {
  error?: string;
  message: string;
  ok: boolean;
  state: RouterKernelState;
}

export interface SaveClaudeRouterProviderInput {
  apiKey?: string;
  baseUrl: string;
  credentialAction: 'clear' | 'keep' | 'replace';
  id?: string;
  makePreferred: boolean;
  models: string[];
  name: string;
  protocol: ClaudeRouterProviderProtocol;
  useForCurrentProject: boolean;
}

export interface ClaudeRouterOperationResult extends FailureMetadata {
  error?: string;
  message: string;
  ok: boolean;
  projectState?: ClaudeProjectState;
  provider?: ClaudeRouterProviderView;
  routerState: ClaudeRouterManagementState;
}
