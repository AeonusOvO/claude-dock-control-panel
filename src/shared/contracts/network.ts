export type NetworkProviderId =
  'ai-services' | 'anthropic-claude' | 'openai-api' | 'openai-codex' | 'xai-grok';

export type NetworkPreflightAction =
  'background' | 'cli-launch' | 'cloud-task' | 'first-request' | 'login' | 'provider-switch';

export type NetworkPreflightScope = 'application' | 'conversation';

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

export type NetworkEnvironmentIssueKind =
  | 'direct-route-mismatch'
  | 'dns-egress'
  | 'evidence-incomplete'
  | 'ip-hygiene'
  | 'ipv6-egress'
  | 'language-mismatch'
  | 'timezone-mismatch';

export interface NetworkEnvironmentCheck {
  detail: string;
  id:
    | 'direct-route'
    | 'dns-authoritative'
    | 'exit-ip'
    | 'ip-reputation'
    | 'ipv6-route'
    | 'language'
    | 'timezone';
  label: string;
  source: string;
  status: 'passed' | 'risk' | 'unknown';
}

export interface NetworkEnvironmentIssue {
  detail: string;
  kind: NetworkEnvironmentIssueKind;
  severity: 'info' | 'warning' | 'high';
  suggestedLanguages?: string[];
  suggestedTimezone?: string;
  title: string;
}

export interface NetworkEnvironmentAssessment {
  checkedAt: number;
  checks?: NetworkEnvironmentCheck[];
  cliLanguages?: string[];
  cliTimezone?: string;
  dnsDetail: string;
  dnsStatus: 'consistent' | 'review' | 'unknown';
  exitAddressPrefix?: string;
  exitCountryCode?: string;
  exitCountryName?: string;
  exitProvider?: string;
  exitTimezone?: string;
  evidenceStatus?: 'complete' | 'partial' | 'unavailable';
  issues: NetworkEnvironmentIssue[];
  localLanguage: string;
  localTimezone: string;
  riskLevel: 'high' | 'low' | 'medium' | 'unknown';
  summary: string;
}

export interface NetworkPreflightResult {
  action: NetworkPreflightAction;
  cacheExpiresAt?: number;
  canonicalCwd?: string;
  checkedAt?: number;
  configurationRevision: string;
  featureAccess: NetworkFeatureAccess[];
  environment?: NetworkEnvironmentAssessment;
  generation: number;
  mainRunId: number;
  networkScope: NetworkPreflightScope;
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
  networkScope?: NetworkPreflightScope;
  provider: NetworkProviderId;
}

export type NetworkPreflightHistoryEntry = Omit<
  NetworkPreflightResult,
  'action' | 'canonicalCwd' | 'configurationRevision' | 'generation' | 'mainRunId' | 'networkScope'
> &
  Partial<
    Pick<
      NetworkPreflightResult,
      'action' | 'configurationRevision' | 'generation' | 'mainRunId' | 'networkScope'
    >
  >;

export interface NetworkPreflightHistoryView {
  entries: NetworkPreflightHistoryEntry[];
  retentionDays: number;
}
