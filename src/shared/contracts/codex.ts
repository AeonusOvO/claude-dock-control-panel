import type { FailureMetadata } from '../diagnostics/failure';
import type { ClaudeLaunchMode } from './claude';
import type { ResourceUsageView } from './resource';

export type CodexLaunchMode = ClaudeLaunchMode;

export type CodexLoginMethod = 'browser' | 'device-code';

export type CodexInstallOperation = 'install' | 'update';

export type CodexActiveOperationKind =
  'cancel-login' | CodexInstallOperation | 'login-browser' | 'login-device' | 'logout';

export interface CodexActiveOperationView {
  /** Monotonic application-global attempt owned by the main process. */
  attempt: number;
  kind: CodexActiveOperationKind;
}

export interface CodexInstallationStatus {
  executable?: string;
  installed: boolean;
  latestVersion?: string;
  message: string;
  updateAvailable: boolean;
  version?: string;
}

export interface CodexAccountView {
  email?: string;
  planType?: string;
  type: 'apiKey' | 'chatgpt' | 'other';
}

export interface CodexRateLimitWindow {
  resetsAt?: number;
  usedPercent: number;
  windowDurationMins?: number;
}

export interface CodexRateLimitsView {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export interface CodexLoginView {
  error?: string;
  loginId?: string;
  method?: CodexLoginMethod;
  phase: 'error' | 'idle' | 'starting' | 'waiting';
  userCode?: string;
  verificationUrl?: string;
}

export interface CodexProjectState {
  account?: CodexAccountView;
  active: boolean;
  activeOperation?: CodexActiveOperationView;
  cwd: string;
  installation: CodexInstallationStatus;
  login: CodexLoginView;
  operationMessage?: string;
  rateLimits?: CodexRateLimitsView;
  /** Monotonic application-global state revision used to reject delayed IPC snapshots. */
  revision: number;
  resourceUsage?: ResourceUsageView;
  requiresOpenaiAuth: boolean;
  sessionId: string;
  warning?: string;
}

export interface CodexOperationResult extends FailureMetadata {
  error?: string;
  ok: boolean;
  state: CodexProjectState;
}

export interface CodexLoginStartResult extends CodexOperationResult {
  openedBrowser?: boolean;
}
