export type EgressAddressFamily = 'ipv4' | 'ipv6';

export type EgressCollectionState =
  'complete' | 'partial' | 'unavailable' | 'cancelled' | 'collecting';

export type EgressFreshness = 'live' | 'recent' | 'dated' | 'unknown';

export type EgressConfidence = 'high' | 'moderate' | 'limited' | 'unknown';

export type EgressAgreement = 'corroborated' | 'mixed' | 'single-source' | 'not-comparable';

export type EgressTransportId = 'electron-net:application-session' | 'local:maxmind-mmdb';

export type EgressProviderId = 'ipify' | 'ipinfo-max' | 'maxmind-anonymous-plus' | 'abuseipdb';

export type EgressEndpointId =
  'public-address-v4' | 'public-address-v6' | 'ipinfo-max-v4' | 'ipinfo-max-v6' | 'abuseipdb-check';

export type EgressSourceTimeLabel =
  | 'http-response'
  | 'geo.last_changed'
  | 'as.last_changed'
  | 'anonymous.last_seen'
  | 'network_last_seen'
  | 'database-file-mtime'
  | 'lastReportedAt';

export interface EgressSourceTime {
  readonly epochMs?: number;
  readonly label: EgressSourceTimeLabel;
  readonly value: string;
}

export interface EgressProvenance {
  readonly collectedAt: number;
  readonly endpointId?: EgressEndpointId;
  readonly provider: EgressProviderId;
  readonly sourceTimes: readonly EgressSourceTime[];
  readonly transport: EgressTransportId;
}

export interface EgressEvidenceAssessment {
  readonly agreement: EgressAgreement;
  readonly confidence: EgressConfidence;
  readonly freshness: EgressFreshness;
}

export type EgressDiagnosticIssueCode =
  | 'missing-credential'
  | 'invalid-configuration'
  | 'invalid-address'
  | 'family-mismatch'
  | 'transport-failed'
  | 'deadline-exceeded'
  | 'cancelled'
  | 'redirect-rejected'
  | 'malformed-response'
  | 'status-mismatch'
  | 'content-type-mismatch'
  | 'body-too-large'
  | 'rate-limited'
  | 'lookup-failed';

export interface EgressDiagnosticIssue {
  readonly code: EgressDiagnosticIssueCode;
  readonly message: string;
  readonly retryAt?: number;
}

export interface EgressExplanation {
  readonly facts: readonly string[];
  readonly recommendations: readonly string[];
  readonly summary: string;
}

/** Exact addresses are intentionally confined to live, in-memory diagnostic shapes. */
export interface LiveExactEgressAddress {
  readonly address: string;
  readonly family: EgressAddressFamily;
}

export interface EgressLiveSourceEvidence {
  readonly address?: LiveExactEgressAddress;
  readonly assessment: EgressEvidenceAssessment;
  readonly explanation: EgressExplanation;
  readonly family: EgressAddressFamily;
  readonly issue?: EgressDiagnosticIssue;
  readonly kind: 'live-source';
  readonly provenance: EgressProvenance;
  readonly state: EgressCollectionState;
}

export interface EgressLiveReport {
  readonly assessment: EgressEvidenceAssessment;
  readonly collectedAt: number;
  readonly explanation: EgressExplanation;
  readonly kind: 'live-report';
  readonly sources: readonly EgressLiveSourceEvidence[];
  readonly state: EgressCollectionState;
}

/** Persisted history may retain only a redacted prefix and a non-reversible fingerprint. */
export interface PersistedRedactedEgressAddress {
  readonly family: EgressAddressFamily;
  readonly fingerprint: string;
  readonly prefix: string;
}

export interface EgressHistoryProviderSummary {
  readonly assessment: EgressEvidenceAssessment;
  readonly provider: EgressProviderId;
  readonly state: Exclude<EgressCollectionState, 'collecting'>;
}

export interface EgressHistoryEntry {
  readonly addresses: readonly PersistedRedactedEgressAddress[];
  readonly collectedAt: number;
  readonly kind: 'history';
  readonly providers: readonly EgressHistoryProviderSummary[];
  readonly state: Exclude<EgressCollectionState, 'collecting'>;
}

export interface EgressRateLimitMetadata {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: number;
  readonly retryAfterSeconds?: number;
}
