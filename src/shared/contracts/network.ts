export type NetworkProviderId = 'anthropic-claude' | 'openai-api' | 'openai-codex';

export type NetworkPreflightAction =
  'background' | 'cli-launch' | 'cloud-task' | 'first-request' | 'login' | 'provider-switch';

export type NetworkPreflightStatus =
  | 'allowed'
  | 'allowed_with_notice'
  | 'blocked'
  | 'degraded'
  | 'partially_available'
  | 'testing'
  | 'unknown'
  | 'warning';

export type NetworkProbeStatus = 'failed' | 'passed' | 'skipped' | 'unknown' | 'warning';

export type NetworkProcessKind =
  'application' | 'claude-cli' | 'codex-cli' | 'oauth-browser' | 'renderer' | 'terminal';

export interface NetworkPathView {
  detail: string;
  dnsServers: string[];
  globalIpv6Available: boolean;
  ipv4Available: boolean;
  ipv6Available: boolean;
  process: NetworkProcessKind;
  proxyConfigured: boolean;
  proxyKind:
    'application-proxy' | 'direct' | 'environment' | 'pac' | 'socks' | 'system' | 'unknown';
  virtualInterfaces: string[];
}

export interface NetworkProbeResult {
  checkedAt: number;
  detail: string;
  id: string;
  kind: 'api' | 'dns' | 'https' | 'oauth' | 'path' | 'tls' | 'version' | 'websocket';
  label: string;
  process: NetworkProcessKind;
  required: boolean;
  status: NetworkProbeStatus;
  target?: string;
}

export interface NetworkRiskSignal {
  confidence: 'high' | 'low' | 'medium';
  detail: string;
  id: string;
  label: string;
  observedAt: number;
  score: number;
  severity: 'critical' | 'info' | 'notice' | 'warning';
  source: string;
}

export interface NetworkFeatureAccess {
  action: NetworkPreflightAction;
  allowed: boolean;
  reason?: string;
}

export interface NetworkPreflightResult {
  cacheExpiresAt?: number;
  checkedAt?: number;
  featureAccess: NetworkFeatureAccess[];
  paths: NetworkPathView[];
  probes: NetworkProbeResult[];
  provider: NetworkProviderId;
  providerLabel: string;
  reasons: string[];
  riskLevel: 'critical' | 'high' | 'low' | 'medium' | 'unknown';
  riskScore: number;
  signals: NetworkRiskSignal[];
  startedAt: number;
  status: NetworkPreflightStatus;
  summary: string;
}

export interface NetworkPreflightRunInput {
  action: NetworkPreflightAction;
  cwd?: string;
  force?: boolean;
  provider: NetworkProviderId;
}

export interface NetworkPreflightHistoryView {
  entries: NetworkPreflightResult[];
  retentionDays: number;
}
