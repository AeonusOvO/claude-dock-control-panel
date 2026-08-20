import type { FailureKind } from '../diagnostics/failure';
import type { NetworkPreflightHistoryView } from './network';
import type { RuntimeActivitySnapshot } from './runtime';

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  code: string;
  detail: string;
  domain: string;
  kind?: FailureKind;
  level: DiagnosticLogLevel;
  message: string;
  occurredAt: number;
}

export type ClaudeStreamFailureKind =
  | 'request-timeout'
  | 'rate-limited'
  | 'upstream-5xx'
  | 'stream-disconnected'
  | 'missing-completion'
  | 'unexpected-eof';

export interface ClaudeStreamDiagnostic {
  backgroundTaskCount: number;
  cliVersion?: string;
  gatewayVersion?: string;
  kind: ClaudeStreamFailureKind;
  occurredAt: number;
  sessionRuntimeMs: number;
}

export interface DiagnosticsQuery {
  code?: string;
  domain?: string;
  level?: DiagnosticLogLevel;
  limit?: number;
  message?: string;
  sessionId?: string;
}

export interface DiagnosticsView {
  claudeStreamFailures: ClaudeStreamDiagnostic[];
  logs: DiagnosticLogEntry[];
  networkHistory: NetworkPreflightHistoryView;
  runtimeActivities: RuntimeActivitySnapshot[];
}
