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

export type NetworkProviderConnectivityStatus = NetworkPreflightStatus;

export type NetworkProbeStatus = 'failed' | 'passed' | 'skipped' | 'unknown' | 'warning';

export type NetworkProcessKind =
  | 'application'
  | 'claude-cli'
  | 'codex-cli'
  | 'network-diagnostics'
  | 'oauth-browser'
  | 'renderer'
  | 'terminal';

export interface NetworkPathView {
  detail: string;
  dnsServers: string[];
  globalIpv6Available: boolean;
  ipv4Available: boolean;
  ipv6Available: boolean;
  networkScope: NetworkPreflightScope;
  process: NetworkProcessKind;
  proxyConfigured: boolean;
  proxyKind:
    | 'application-proxy'
    | 'direct'
    | 'environment'
    | 'pac'
    | 'socks'
    | 'socks5h'
    | 'system'
    | 'unknown';
  target: string;
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
  | 'dns-egress'
  | 'evidence-incomplete'
  | 'ip-hygiene'
  | 'ipv6-egress'
  | 'language-mismatch'
  | 'timezone-mismatch';

export type NetworkEvidenceFreshness = 'cached' | 'live' | 'unknown';

export type NetworkEnvironmentEvidenceTransport =
  'curl-cli' | 'derived' | 'local-system' | 'not-collected' | 'system-dns';

export interface NetworkEnvironmentCheck {
  authority: 'advisory-only';
  checkedAt: number;
  confidence: 'high' | 'low' | 'medium' | 'unknown';
  detail: string;
  freshness: NetworkEvidenceFreshness;
  id:
    | 'dns-authoritative'
    | 'ip-reputation'
    | 'ipv6-public-address'
    | 'language'
    | 'public-address-ipip'
    | 'public-address-ipquery'
    | 'stun-public-address'
    | 'timezone';
  label: string;
  networkScope: NetworkPreflightScope;
  process: NetworkProcessKind;
  source: string;
  status: 'passed' | 'risk' | 'unavailable' | 'unknown';
  target: string;
  transport: NetworkEnvironmentEvidenceTransport;
}

export interface NetworkEnvironmentIssue {
  detail: string;
  kind: NetworkEnvironmentIssueKind;
  severity: 'info' | 'warning' | 'high';
  suggestedLanguages?: string[];
  suggestedTimezone?: string;
  title: string;
}

export interface NetworkPublicAddressObservation {
  addressFamily?: 'ipv4' | 'ipv6';
  addressPrefix?: string;
  checkedAt: number;
  confidence: 'high' | 'low' | 'medium' | 'unknown';
  countryCode?: string;
  countryName?: string;
  detail: string;
  endpoint: string;
  freshness: NetworkEvidenceFreshness;
  networkProvider?: string;
  networkScope: NetworkPreflightScope;
  observationProvider: string;
  process: NetworkProcessKind;
  sourceAgreement: 'corroborated' | 'mixed' | 'not-comparable' | 'single-source';
  state: 'complete' | 'unavailable';
  statement: string;
  timezone?: string;
  transport: 'curl-cli';
}

export interface NetworkEnvironmentAssessment {
  checkedAt: number;
  checks?: NetworkEnvironmentCheck[];
  cliLanguages?: string[];
  cliTimezone?: string;
  dnsDetail: string;
  dnsStatus: 'consistent' | 'review' | 'unknown';
  evidenceStatus?: 'complete' | 'partial' | 'unavailable';
  issues: NetworkEnvironmentIssue[];
  localLanguage: string;
  localTimezone: string;
  publicAddressObservations: NetworkPublicAddressObservation[];
  riskLevel: 'high' | 'low' | 'medium' | 'unknown';
  summary: string;
}

export interface NetworkProviderConnectivityAssessment {
  featureAccess: NetworkFeatureAccess[];
  probes: NetworkProbeResult[];
  reasons: string[];
  signals: NetworkRiskSignal[];
  status: NetworkProviderConnectivityStatus;
  summary: string;
}

export interface NetworkAdvisoryEvidenceAssessment {
  environment?: NetworkEnvironmentAssessment;
  paths: NetworkPathView[];
  reasons: string[];
  riskLevel: 'high' | 'low' | 'medium' | 'unknown';
  riskScore: number;
  signals: NetworkRiskSignal[];
  summary: string;
}

export interface NetworkPreflightResult {
  action: NetworkPreflightAction;
  advisoryEvidence: NetworkAdvisoryEvidenceAssessment;
  cacheExpiresAt?: number;
  canonicalCwd?: string;
  checkedAt?: number;
  configurationRevision: string;
  generation: number;
  mainRunId: number;
  networkScope: NetworkPreflightScope;
  provider: NetworkProviderId;
  providerConnectivity: NetworkProviderConnectivityAssessment;
  providerLabel: string;
  schemaVersion: 2;
  startedAt: number;

  /** @deprecated Compatibility projection. Provider admission must use providerConnectivity. */
  featureAccess: NetworkFeatureAccess[];
  /** @deprecated Compatibility projection. Advisory evidence lives under advisoryEvidence. */
  environment?: NetworkEnvironmentAssessment;
  /** @deprecated Compatibility projection. Advisory evidence lives under advisoryEvidence. */
  paths: NetworkPathView[];
  /** @deprecated Compatibility projection. Provider evidence lives under providerConnectivity. */
  probes: NetworkProbeResult[];
  /** @deprecated Compatibility projection. Provider reasons live under providerConnectivity. */
  reasons: string[];
  /** @deprecated Compatibility projection of advisoryEvidence.riskLevel. */
  riskLevel: 'critical' | 'high' | 'low' | 'medium' | 'unknown';
  /** @deprecated Compatibility projection of advisoryEvidence.riskScore. */
  riskScore: number;
  /** @deprecated Compatibility projection of both explicitly separated signal lanes. */
  signals: NetworkRiskSignal[];
  /** @deprecated Compatibility status derived from provider connectivity plus visible notices. */
  status: NetworkPreflightStatus;
  /** @deprecated Compatibility projection of providerConnectivity.summary. */
  summary: string;
}

export interface NetworkPreflightRunInput {
  action: NetworkPreflightAction;
  cwd?: string;
  force?: boolean;
  networkScope?: NetworkPreflightScope;
  provider: NetworkProviderId;
}

export type NetworkPreflightHistoryEntryV2 = Omit<
  NetworkPreflightResult,
  | 'canonicalCwd'
  | 'environment'
  | 'featureAccess'
  | 'paths'
  | 'probes'
  | 'reasons'
  | 'riskLevel'
  | 'riskScore'
  | 'signals'
  | 'status'
  | 'summary'
>;

export interface NetworkPreflightHistoryEntryV1 {
  checkedAt?: number;
  legacyComposite: Record<string, unknown>;
  schemaVersion: 1;
  startedAt: number;
}

export type NetworkPreflightHistoryEntry =
  NetworkPreflightHistoryEntryV1 | NetworkPreflightHistoryEntryV2;

export interface NetworkPreflightHistoryView {
  entries: NetworkPreflightHistoryEntry[];
  retentionDays: number;
}
