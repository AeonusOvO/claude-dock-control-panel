import type { FailureMetadata } from '../diagnostics/failure';

/**
 * A user-owned proxy that already exists outside ClaudeDock, such as an organisation-managed
 * gateway. ClaudeDock only passes the address to selected application processes and never edits
 * Windows proxy settings.
 */
export type ApplicationProxyProtocol = 'http' | 'socks5';

export interface ApplicationProxyScope {
  application: boolean;
  cli: boolean;
  conversation: boolean;
}

export interface ApplicationProxyView {
  enabled: boolean;
  host: string;
  passwordConfigured: boolean;
  port?: number;
  protocol: ApplicationProxyProtocol;
  scope: ApplicationProxyScope;
  updatedAt?: number;
  username: string;
}

export interface SaveApplicationProxyInput {
  enabled: boolean;
  host: string;
  /** Empty keeps the existing encrypted password; clearing username clears both credentials. */
  password?: string;
  port?: number;
  protocol: ApplicationProxyProtocol;
  scope: ApplicationProxyScope;
  username?: string;
}

export interface ApplicationProxyTestResult extends FailureMetadata {
  checkedAt: number;
  latencyMs?: number;
  message: string;
  ok: boolean;
}

export interface ApplicationProxyState {
  config: ApplicationProxyView;
  test?: ApplicationProxyTestResult;
}

export interface ApplicationProxyCandidate {
  host: string;
  label: string;
  port: number;
  protocol: ApplicationProxyProtocol;
}
