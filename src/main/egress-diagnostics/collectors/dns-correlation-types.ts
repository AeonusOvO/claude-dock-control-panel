import type { EgressAddressFamily } from '../../../shared/contracts/egress-diagnostics';

export type { EgressAddressFamily } from '../../../shared/contracts/egress-diagnostics';

export type DnsEvidenceState = 'observed' | 'partial' | 'unavailable';
export type DnsCorrelationState = 'disabled' | 'unavailable' | 'partial' | 'correlated';

export interface DnsAddressObservation {
  readonly address: string;
  readonly family: EgressAddressFamily;
}

export interface OsResolverFacts {
  readonly dnsOverHttps?: 'automatic' | 'disabled' | 'enabled' | 'mixed' | 'unknown';
  readonly observedAt?: number;
  readonly resolverAddresses: readonly string[];
}

export type ReadOsResolverFacts = (signal: AbortSignal) => Promise<OsResolverFacts>;

export interface SessionResolvedEndpoint {
  readonly address: string;
  readonly family: 'ipv4' | 'ipv6' | 'unspec';
}

export interface SessionResolvedHost {
  readonly endpoints: readonly SessionResolvedEndpoint[];
}

export interface SessionResolveHostOptions {
  readonly cacheUsage: 'disallowed';
  readonly queryType: 'A' | 'AAAA';
  readonly secureDnsPolicy: 'allow';
}

export type ResolveApplicationSessionHost = (
  hostname: string,
  options: SessionResolveHostOptions,
) => Promise<SessionResolvedHost>;

export type DnsApplicationRequestPurpose = 'control' | 'correlation-host' | 'result';

/**
 * A narrow request shape for a bounded Electron application-Session transport. It intentionally has
 * no headers or credential input. The adapter must reject redirects and cancel pending transport
 * work when `signal` aborts.
 */
export interface DnsApplicationSessionRequest {
  readonly cache: 'no-store';
  readonly credentials: 'omit';
  readonly deadlineAt: number;
  readonly maxResponseBytes: number;
  readonly method: 'GET';
  readonly privacy: 'never-log-url-body-or-addresses';
  readonly purpose: DnsApplicationRequestPurpose;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
  readonly url: string;
}

/**
 * The bounded transport owns response draining. `drain` must synchronously initiate draining or
 * cancellation and is called on success, parser rejection, cancellation races, and other failures.
 */
export interface DnsApplicationSessionResponse {
  readonly body: string;
  readonly contentType: string;
  readonly drain: () => void;
  readonly status: number;
}

export type DnsApplicationSessionRequester = (
  request: DnsApplicationSessionRequest,
) => Promise<DnsApplicationSessionResponse>;

export interface SignedDnsCorrelationGrant {
  readonly expiresAt: number;
  readonly hostname: string;
  readonly id: string;
  readonly nonce: string;
  readonly signature: string;
}

export type VerifySignedDnsCorrelationGrant = (
  grant: SignedDnsCorrelationGrant,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

export interface ApprovedDnsCorrelationServicePolicy {
  readonly allowExactEcsSubnet: boolean;
  readonly approval: 'main-owned-dns-correlation-service';
  readonly controlOrigin: string;
  readonly controlPath: string;
  readonly correlationSuffix: string;
  readonly maxClockSkewMs: number;
  readonly maxControlResponseBytes: number;
  readonly maxPollAttempts: number;
  readonly maxProbeResponseBytes: number;
  readonly maxResolverAddresses: number;
  readonly maxResultResponseBytes: number;
  readonly maxTokenLifetimeMs: number;
  readonly pollIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly resultOrigin: string;
  readonly resultPath: string;
  readonly totalDeadlineMs: number;
}

export interface DnsCorrelationCollectorPorts {
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly readOsResolverFacts?: ReadOsResolverFacts;
  readonly requestApplicationSession?: DnsApplicationSessionRequester;
  readonly resolveApplicationSessionHost: ResolveApplicationSessionHost;
  readonly verifySignedGrant?: VerifySignedDnsCorrelationGrant;
}

export interface CollectDnsEvidenceInput {
  readonly approvedService?: ApprovedDnsCorrelationServicePolicy;
  readonly hostname: string;
  readonly signal?: AbortSignal;
  readonly totalDeadlineMs?: number;
}

export interface OsResolverConfigurationEvidence {
  readonly applicationRequestCorrelationEstablished: false;
  readonly electronSessionResolutionEstablished: false;
  readonly lane: 'os-resolver-configuration';
  readonly observedAt: number;
  readonly proxyDestinationDnsRoutingEstablished: false;
  readonly resolverAddresses: readonly DnsAddressObservation[];
  readonly dnsOverHttps: 'automatic' | 'disabled' | 'enabled' | 'mixed' | 'unknown';
  readonly state: DnsEvidenceState;
  readonly weight: 'supporting-only';
}

export interface ApplicationSessionResolverEvidence {
  readonly applicationRequestCorrelationEstablished: false;
  readonly addresses: readonly DnsAddressObservation[];
  readonly hostname: string;
  readonly lane: 'electron-application-session-resolver';
  readonly observedAt: number;
  readonly proxyDestinationDnsRoutingEstablished: false;
  readonly state: DnsEvidenceState;
  readonly weight: 'session-resolver-observation-only';
}

export interface EcsObservation {
  readonly observed: boolean;
  readonly prefixLength?: number;
}

export type RecursiveResolverObservation = DnsAddressObservation;

export interface AuthoritativeDnsCorrelationEvidence {
  readonly attribution: 'application-session-request-correlation-only';
  readonly ecs: EcsObservation;
  readonly lane: 'authoritative-application-request-correlation';
  readonly observedAt?: number;
  readonly proxyDestinationDnsRoutingEstablished: false;
  readonly recursiveResolvers: readonly RecursiveResolverObservation[];
  readonly sourceTime?: number;
  readonly state: DnsCorrelationState;
}

export interface DnsEvidenceCollection {
  readonly advisoryOnly: true;
  readonly authoritativeCorrelation: AuthoritativeDnsCorrelationEvidence;
  readonly collectedAt: number;
  readonly osResolverConfiguration: OsResolverConfigurationEvidence;
  readonly preflightDisposition: 'unchanged';
  readonly sessionResolverObservation: ApplicationSessionResolverEvidence;
}

export interface DnsCorrelationResultParsePolicy {
  readonly allowExactEcsSubnet: boolean;
  readonly maxClockSkewMs: number;
  readonly maxResolverAddresses: number;
  readonly maxResponseBytes: number;
  readonly now: number;
}

export interface ParsedDnsCorrelationResult {
  readonly ecs: EcsObservation;
  readonly observedAt?: number;
  readonly recursiveResolvers: readonly RecursiveResolverObservation[];
  readonly sourceTime?: number;
  readonly state: 'correlated' | 'partial' | 'pending' | 'unavailable';
}

export type DnsAddressHmacSigner = (message: string) => Uint8Array;

export interface PersistedDnsAddressEvidence {
  readonly family: EgressAddressFamily;
  readonly fingerprint: string;
  readonly network: string;
}

export interface PersistedDnsEvidenceCollection {
  readonly advisoryOnly: true;
  readonly authoritativeCorrelation: {
    readonly attribution: 'application-session-request-correlation-only';
    readonly ecs: EcsObservation;
    readonly observedAt?: number;
    readonly proxyDestinationDnsRoutingEstablished: false;
    readonly recursiveResolvers: readonly PersistedDnsAddressEvidence[];
    readonly sourceTime?: number;
    readonly state: DnsCorrelationState;
  };
  readonly collectedAt: number;
  readonly osResolverConfiguration: {
    readonly dnsOverHttps: OsResolverConfigurationEvidence['dnsOverHttps'];
    readonly observedAt: number;
    readonly resolverAddresses: readonly PersistedDnsAddressEvidence[];
    readonly state: DnsEvidenceState;
    readonly weight: 'supporting-only';
  };
  readonly preflightDisposition: 'unchanged';
  readonly schemaVersion: 1;
  readonly sessionResolverObservation: {
    readonly addresses: readonly PersistedDnsAddressEvidence[];
    readonly hostname: string;
    readonly observedAt: number;
    readonly state: DnsEvidenceState;
    readonly weight: 'session-resolver-observation-only';
  };
}
