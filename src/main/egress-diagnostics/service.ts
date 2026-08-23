import type {
  EgressCollectionState,
  EgressDiagnosticIssue,
  EgressEvidenceAssessment,
  EgressHistoryEntry,
  EgressHistoryProviderSummary,
  EgressLiveSourceEvidence,
  EgressProviderId,
  LiveExactEgressAddress,
  PersistedRedactedEgressAddress,
} from '../../shared/contracts/egress-diagnostics';
import type { ApplicationNetworkLease } from '../proxy/application-proxy-coordinator';
import type { AbuseIpDbCollectInput, AbuseIpDbEvidence } from './adapters/abuseipdb';
import type { IpinfoMaxCollectInput, IpinfoMaxEvidence } from './adapters/ipinfo-max';
import type {
  MaxMindAnonymousPlusCollectInput,
  MaxMindAnonymousPlusEvidence,
} from './adapters/maxmind-anonymous-plus';
import { redactEgressAddresses } from './address-redactor';
import type { PublicAddressCollection } from './collectors/public-address';
import type { DnsEvidenceCollection } from './collectors/dns-correlation-types';
import { deriveEvidenceAssessment } from './evidence-policy';
import { createEgressExplanation } from './explanation';
import { isUnknownRecord } from './parsing';
import { sanitizeStunResultCandidates } from './stun-result-sanitizer';
import {
  STUN_DIAGNOSTIC_SCOPE,
  type StunCollectionRequest,
  type StunDiagnosticCandidate,
  type StunDiagnosticResult,
  type StunDiagnosticUnavailableReason,
} from './webrtc/stun-collector';

const APPLICATION_SCOPE = 'application' as const;
const STUN_SCOPE = STUN_DIAGNOSTIC_SCOPE;

const STUN_UNAVAILABLE_REASONS: ReadonlySet<StunDiagnosticUnavailableReason> = new Set([
  'aborted',
  'busy',
  'disposed',
  'failed',
  'navigation-attempt',
  'no-approved-endpoint',
  'no-public-candidate',
  'not-opted-in',
  'render-process-gone',
  'timeout',
  'unresponsive',
]);

export interface EgressDiagnosticsCollectInput {
  /** Main-process callers set this only from an explicit trusted user opt-in decision. */
  readonly includeStun: boolean;
  readonly scope: typeof APPLICATION_SCOPE;
  readonly signal?: AbortSignal;
}

export interface EgressDiagnosticsHistory {
  append(entry: EgressHistoryEntry): EgressHistoryEntry;
  clear(): void;
  export(): readonly EgressHistoryEntry[];
}

export interface EgressDiagnosticsDnsCollector {
  /** The fixed hostname used by the injected, main-approved DNS collector. */
  readonly hostname: string;
  collect(signal: AbortSignal): Promise<DnsEvidenceCollection>;
}

export interface EgressDiagnosticsStunCollector {
  collect(request: StunCollectionRequest): Promise<StunDiagnosticResult>;
  dispose(): void;
}

export interface EgressDiagnosticsServiceOptions {
  readonly abuseIpDb: {
    collect(input: AbuseIpDbCollectInput): Promise<AbuseIpDbEvidence>;
  };
  readonly acquireNetworkLease: (
    scope: typeof APPLICATION_SCOPE,
  ) => Promise<ApplicationNetworkLease>;
  /** Returns a copy of the main-owned installation key, never a renderer-provided value. */
  readonly addressFingerprintKey: () => Uint8Array | undefined;
  readonly dnsCorrelation: EgressDiagnosticsDnsCollector;
  readonly history: EgressDiagnosticsHistory;
  readonly ipinfoMax: {
    collect(input: IpinfoMaxCollectInput): Promise<IpinfoMaxEvidence>;
  };
  readonly maxMindAnonymousPlus: {
    close?(): Promise<void> | void;
    collect(input: MaxMindAnonymousPlusCollectInput): Promise<MaxMindAnonymousPlusEvidence>;
  };
  readonly now?: () => number;
  readonly onObservabilityError?: (
    phase: 'history-write' | 'result-publication' | 'resource-disposal',
    error: unknown,
  ) => void;
  readonly onResult?: (result: EgressDiagnosticsLiveResult) => void;
  readonly publicAddress: {
    collect(input: {
      readonly leaseCurrent: boolean;
      readonly signal?: AbortSignal;
    }): Promise<PublicAddressCollection>;
  };
  readonly stun?: EgressDiagnosticsStunCollector;
}

export interface EgressDiagnosticsDnsEvidence {
  readonly evidence: DnsEvidenceCollection;
  readonly provenance: {
    readonly authoritativeSource: 'injected-approved-service-only';
    readonly publicFallback: false;
    readonly source: 'dns-authoritative';
  };
}

export type EgressDiagnosticsStunEvidence =
  | {
      readonly candidates: readonly StunDiagnosticCandidate[];
      readonly provenance: {
        readonly explicitTrustedOptIn: true;
        readonly proxyEgressAttribution: false;
        readonly source: 'webrtc-stun';
      };
      readonly scope: typeof STUN_SCOPE;
      readonly status: 'available';
    }
  | {
      readonly provenance: {
        readonly explicitTrustedOptIn: boolean;
        readonly proxyEgressAttribution: false;
        readonly source: 'webrtc-stun';
      };
      readonly reason: StunDiagnosticUnavailableReason;
      readonly scope: typeof STUN_SCOPE;
      readonly status: 'unavailable';
    }
  | {
      readonly provenance: {
        readonly explicitTrustedOptIn: false;
        readonly proxyEgressAttribution: false;
        readonly source: 'webrtc-stun';
      };
      readonly scope: typeof STUN_SCOPE;
      readonly status: 'not-requested';
    };

export interface EgressStunPathMismatchSignal {
  readonly family: LiveExactEgressAddress['family'];
  readonly interpretation: 'possible-leak-or-path-mismatch';
  readonly kind: 'stun-address-difference';
  readonly proxyEgressAttribution: false;
  readonly transport: StunDiagnosticCandidate['transport'];
}

/** Main-process-only live result. It is intentionally not part of the shared renderer contracts. */
export interface EgressDiagnosticsLiveResult {
  readonly abuseIpDb: readonly AbuseIpDbEvidence[];
  readonly advisoryOnly: true;
  readonly collectedAt: number;
  readonly dns: EgressDiagnosticsDnsEvidence;
  readonly generation: number;
  readonly ipinfoMax: readonly IpinfoMaxEvidence[];
  readonly kind: 'egress-diagnostics-live';
  readonly maxMindAnonymousPlus: readonly MaxMindAnonymousPlusEvidence[];
  readonly publicAddress: PublicAddressCollection;
  readonly scope: typeof APPLICATION_SCOPE;
  readonly state: Exclude<EgressCollectionState, 'collecting'>;
  readonly stun: EgressDiagnosticsStunEvidence;
  readonly stunPathSignals: readonly EgressStunPathMismatchSignal[];
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly generation: number;
  completion?: Promise<void>;
}

interface CollectionBatch {
  readonly abuseIpDb: readonly AbuseIpDbEvidence[];
  readonly dns: DnsEvidenceCollection;
  readonly ipinfoMax: readonly IpinfoMaxEvidence[];
  readonly maxMindAnonymousPlus: readonly MaxMindAnonymousPlusEvidence[];
  readonly stun: EgressDiagnosticsStunEvidence;
}

export class EgressDiagnosticsSupersededError extends Error {
  public constructor(
    public readonly startedGeneration: number,
    public readonly currentGeneration: number,
    cause?: unknown,
  ) {
    super(
      'The egress diagnostic run was superseded by a newer authoritative run.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'EgressDiagnosticsSupersededError';
  }
}

export class EgressDiagnosticsCancelledError extends Error {
  public constructor() {
    super('The egress diagnostic run was cancelled.');
    this.name = 'EgressDiagnosticsCancelledError';
  }
}

export class EgressDiagnosticsDisposedError extends Error {
  public constructor() {
    super('The egress diagnostics service has been disposed.');
    this.name = 'EgressDiagnosticsDisposedError';
  }
}

export class EgressDiagnosticsLeaseError extends Error {
  public constructor(
    message = 'The egress diagnostic lease did not cover exactly application scope.',
  ) {
    super(message);
    this.name = 'EgressDiagnosticsLeaseError';
  }
}

const issue = (message: string): EgressDiagnosticIssue => ({
  code: 'transport-failed',
  message,
});

const unavailableAssessment = (
  transport: 'electron-net:application-session' | 'local:maxmind-mmdb',
): EgressEvidenceAssessment =>
  deriveEvidenceAssessment({
    collectionState: 'unavailable',
    leaseCurrent: true,
    sourceFreshness: 'unknown',
    strictParse: false,
    transport,
  });

const unavailableSource = (
  provider: EgressProviderId,
  family: LiveExactEgressAddress['family'],
  collectedAt: number,
  transport: 'electron-net:application-session' | 'local:maxmind-mmdb',
  sourceIssue: EgressDiagnosticIssue,
): EgressLiveSourceEvidence & { readonly provider: EgressProviderId } => {
  const assessment = unavailableAssessment(transport);
  return {
    assessment,
    explanation: createEgressExplanation({
      assessment,
      family,
      issueCode: sourceIssue.code,
      provider,
      state: 'unavailable',
    }),
    family,
    issue: sourceIssue,
    kind: 'live-source',
    provider,
    provenance: {
      collectedAt,
      provider,
      sourceTimes: [],
      transport,
    },
    state: 'unavailable',
  };
};

const unavailableIpinfo = (
  family: LiveExactEgressAddress['family'],
  collectedAt: number,
): IpinfoMaxEvidence => ({
  ...unavailableSource(
    'ipinfo-max',
    family,
    collectedAt,
    'electron-net:application-session',
    issue('IPinfo Max evidence collection failed.'),
  ),
  provider: 'ipinfo-max',
});

const unavailableMaxMind = (
  family: LiveExactEgressAddress['family'],
  collectedAt: number,
): MaxMindAnonymousPlusEvidence => ({
  ...unavailableSource(
    'maxmind-anonymous-plus',
    family,
    collectedAt,
    'local:maxmind-mmdb',
    issue('MaxMind Anonymous Plus evidence collection failed.'),
  ),
  provider: 'maxmind-anonymous-plus',
});

const unavailableAbuseIpDb = (
  family: LiveExactEgressAddress['family'],
  collectedAt: number,
): AbuseIpDbEvidence => ({
  ...unavailableSource(
    'abuseipdb',
    family,
    collectedAt,
    'electron-net:application-session',
    issue('AbuseIPDB evidence collection failed.'),
  ),
  provider: 'abuseipdb',
  rateLimit: {},
});

const unavailablePublicAddress = (collectedAt: number): PublicAddressCollection => {
  const sourceFor = (family: LiveExactEgressAddress['family']) => {
    const sourceIssue = issue('The public-address source failed.');
    const assessment = unavailableAssessment('electron-net:application-session');
    return {
      assessment,
      explanation: createEgressExplanation({
        assessment,
        family,
        issueCode: sourceIssue.code,
        provider: 'ipify',
        state: 'unavailable',
      }),
      family,
      issue: sourceIssue,
      kind: 'live-source' as const,
      provider: 'ipify' as const,
      provenance: {
        collectedAt,
        endpointId:
          family === 'ipv4' ? ('public-address-v4' as const) : ('public-address-v6' as const),
        provider: 'ipify' as const,
        sourceTimes: [],
        transport: 'electron-net:application-session' as const,
      },
      state: 'unavailable' as const,
    };
  };
  const sources = [sourceFor('ipv4'), sourceFor('ipv6')] as const;
  const assessment = unavailableAssessment('electron-net:application-session');
  return {
    assessment,
    collectedAt,
    explanation: {
      facts: ['IPv4 collection is unavailable.', 'IPv6 collection is unavailable.'],
      recommendations: ['Retry the main-owned public-address collection.'],
      summary: 'Public-address collection is unavailable.',
    },
    kind: 'live-report',
    sources,
    state: 'unavailable',
  };
};

const unavailableDns = (hostname: string, collectedAt: number): DnsEvidenceCollection => ({
  advisoryOnly: true,
  authoritativeCorrelation: {
    attribution: 'application-session-request-correlation-only',
    ecs: { observed: false },
    lane: 'authoritative-application-request-correlation',
    proxyDestinationDnsRoutingEstablished: false,
    recursiveResolvers: [],
    state: 'unavailable',
  },
  collectedAt,
  osResolverConfiguration: {
    applicationRequestCorrelationEstablished: false,
    dnsOverHttps: 'unknown',
    electronSessionResolutionEstablished: false,
    lane: 'os-resolver-configuration',
    observedAt: collectedAt,
    proxyDestinationDnsRoutingEstablished: false,
    resolverAddresses: [],
    state: 'unavailable',
    weight: 'supporting-only',
  },
  preflightDisposition: 'unchanged',
  sessionResolverObservation: {
    addresses: [],
    applicationRequestCorrelationEstablished: false,
    hostname,
    lane: 'electron-application-session-resolver',
    observedAt: collectedAt,
    proxyDestinationDnsRoutingEstablished: false,
    state: 'unavailable',
    weight: 'session-resolver-observation-only',
  },
});

const stunProvenance = <T extends boolean>(explicitTrustedOptIn: T) => ({
  explicitTrustedOptIn,
  proxyEgressAttribution: false as const,
  source: 'webrtc-stun' as const,
});

const unavailableStun = (
  reason: StunDiagnosticUnavailableReason,
  explicitTrustedOptIn: boolean,
): EgressDiagnosticsStunEvidence => ({
  provenance: stunProvenance(explicitTrustedOptIn),
  reason,
  scope: STUN_SCOPE,
  status: 'unavailable',
});

const notRequestedStun = (): EgressDiagnosticsStunEvidence => ({
  provenance: stunProvenance(false),
  scope: STUN_SCOPE,
  status: 'not-requested',
});

const normalizeStunEvidence = (value: unknown): EgressDiagnosticsStunEvidence => {
  if (!isUnknownRecord(value) || value.scope !== STUN_SCOPE) {
    return unavailableStun('failed', true);
  }
  if (value.status === 'unavailable') {
    const reason = value.reason;
    return typeof reason === 'string' &&
      STUN_UNAVAILABLE_REASONS.has(reason as StunDiagnosticUnavailableReason)
      ? unavailableStun(reason as StunDiagnosticUnavailableReason, true)
      : unavailableStun('failed', true);
  }
  if (value.status !== 'available' || !Array.isArray(value.candidates)) {
    return unavailableStun('failed', true);
  }
  const candidates = sanitizeStunResultCandidates(value.candidates);
  return candidates.length === 0
    ? unavailableStun('no-public-candidate', true)
    : {
        candidates,
        provenance: stunProvenance(true),
        scope: value.scope,
        status: 'available',
      };
};

const exactBaselines = (collection: PublicAddressCollection): readonly LiveExactEgressAddress[] =>
  collection.sources.flatMap((source) =>
    source.state === 'complete' && source.address ? [source.address] : [],
  );

const stunPathSignals = (
  baselines: readonly LiveExactEgressAddress[],
  evidence: EgressDiagnosticsStunEvidence,
): readonly EgressStunPathMismatchSignal[] => {
  if (evidence.status !== 'available') return Object.freeze([]);
  const baselineByFamily = new Map(
    baselines.map((baseline) => [baseline.family, baseline.address]),
  );
  const seen = new Set<string>();
  const signals: EgressStunPathMismatchSignal[] = [];
  for (const candidate of evidence.candidates) {
    const baseline = baselineByFamily.get(candidate.family);
    if (!baseline || baseline === candidate.address) continue;
    const identity = `${candidate.family}:${candidate.transport}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    signals.push({
      family: candidate.family,
      interpretation: 'possible-leak-or-path-mismatch',
      kind: 'stun-address-difference',
      proxyEgressAttribution: false,
      transport: candidate.transport,
    });
  }
  return Object.freeze(signals);
};

const aggregateState = (
  sources: readonly EgressLiveSourceEvidence[],
): Exclude<EgressCollectionState, 'collecting'> => {
  if (sources.length === 0) return 'unavailable';
  const complete = sources.filter((source) => source.state === 'complete').length;
  if (complete === sources.length) return 'complete';
  if (complete > 0) return 'partial';
  if (sources.every((source) => source.state === 'cancelled')) return 'cancelled';
  return 'unavailable';
};

const freshnessRank: Readonly<Record<EgressEvidenceAssessment['freshness'], number>> = {
  live: 0,
  recent: 1,
  dated: 2,
  unknown: 3,
};

const confidenceRank: Readonly<Record<EgressEvidenceAssessment['confidence'], number>> = {
  high: 0,
  moderate: 1,
  limited: 2,
  unknown: 3,
};

const providerAssessment = (
  state: Exclude<EgressCollectionState, 'collecting'>,
  sources: readonly EgressLiveSourceEvidence[],
): EgressEvidenceAssessment => {
  const completed = sources.filter((source) => source.state === 'complete');
  if (state === 'unavailable' || state === 'cancelled' || completed.length === 0) {
    return { agreement: 'not-comparable', confidence: 'unknown', freshness: 'unknown' };
  }
  const agreement = completed.some((source) => source.assessment.agreement === 'mixed')
    ? 'mixed'
    : completed.every((source) => source.assessment.agreement === 'corroborated')
      ? 'corroborated'
      : completed.length === 1
        ? completed[0]!.assessment.agreement
        : 'single-source';
  const freshness = completed.reduce(
    (current, source) =>
      freshnessRank[source.assessment.freshness] > freshnessRank[current]
        ? source.assessment.freshness
        : current,
    completed[0]!.assessment.freshness,
  );
  const sourceConfidence = completed.reduce(
    (current, source) =>
      confidenceRank[source.assessment.confidence] > confidenceRank[current]
        ? source.assessment.confidence
        : current,
    completed[0]!.assessment.confidence,
  );
  return {
    agreement,
    confidence:
      state === 'partial' && sourceConfidence !== 'unknown' ? 'limited' : sourceConfidence,
    freshness,
  };
};

const providerSummary = (
  provider: EgressProviderId,
  sources: readonly EgressLiveSourceEvidence[],
): EgressHistoryProviderSummary => {
  const state = aggregateState(sources);
  return {
    assessment: providerAssessment(state, sources),
    provider,
    state,
  };
};

const overallState = (
  publicAddress: PublicAddressCollection,
  batch: CollectionBatch,
): Exclude<EgressCollectionState, 'collecting'> => {
  if (publicAddress.state === 'cancelled') return 'cancelled';
  if (exactBaselines(publicAddress).length === 0) return 'unavailable';
  const sourceStates = [
    publicAddress.state,
    ...batch.ipinfoMax.map((source) => source.state),
    ...batch.maxMindAnonymousPlus.map((source) => source.state),
    ...batch.abuseIpDb.map((source) => source.state),
  ];
  const dnsComplete =
    batch.dns.authoritativeCorrelation.state === 'correlated' &&
    batch.dns.osResolverConfiguration.state === 'observed' &&
    batch.dns.sessionResolverObservation.state === 'observed';
  const stunComplete = batch.stun.status === 'not-requested' || batch.stun.status === 'available';
  return sourceStates.every((state) => state === 'complete') && dnsComplete && stunComplete
    ? 'complete'
    : 'partial';
};

const cloneHistoryEntry = (entry: EgressHistoryEntry): EgressHistoryEntry =>
  Object.freeze({
    addresses: Object.freeze(entry.addresses.map((address) => Object.freeze({ ...address }))),
    collectedAt: entry.collectedAt,
    kind: 'history' as const,
    providers: Object.freeze(
      entry.providers.map((provider) =>
        Object.freeze({
          assessment: Object.freeze({ ...provider.assessment }),
          provider: provider.provider,
          state: provider.state,
        }),
      ),
    ),
    state: entry.state,
  });

export class EgressDiagnosticsService {
  private activeRun?: ActiveRun;
  private readonly backgroundTasks = new Set<Promise<unknown>>();
  private disposed = false;
  private disposePromise?: Promise<void>;
  private generation = 0;
  private latestRedacted?: EgressHistoryEntry;
  private readonly now: () => number;

  public constructor(private readonly options: EgressDiagnosticsServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  public collect(input: EgressDiagnosticsCollectInput): Promise<EgressDiagnosticsLiveResult> {
    if (this.disposed) return Promise.reject(new EgressDiagnosticsDisposedError());
    if (!input || input.scope !== APPLICATION_SCOPE || typeof input.includeStun !== 'boolean') {
      return Promise.reject(new TypeError('Egress diagnostics require exact application scope.'));
    }
    if (input.signal?.aborted) return Promise.reject(new EgressDiagnosticsCancelledError());

    const predecessor = this.activeRun;
    const generation = this.generation + 1;
    this.generation = generation;
    predecessor?.controller.abort(
      new EgressDiagnosticsSupersededError(predecessor.generation, generation),
    );

    const run: ActiveRun = { controller: new AbortController(), generation };
    const externalAbort = (): void => run.controller.abort(new EgressDiagnosticsCancelledError());
    input.signal?.addEventListener('abort', externalAbort, { once: true });
    const predecessorCompletion = predecessor?.completion ?? Promise.resolve();
    const execution = this.executeRun(run, input, predecessorCompletion).finally(() => {
      input.signal?.removeEventListener('abort', externalAbort);
      if (this.activeRun === run) this.activeRun = undefined;
    });
    run.completion = execution.then(
      () => undefined,
      () => undefined,
    );
    this.activeRun = run;
    return execution;
  }

  public getLatestRedacted(): EgressHistoryEntry | undefined {
    return this.latestRedacted ? cloneHistoryEntry(this.latestRedacted) : undefined;
  }

  public export(): readonly EgressHistoryEntry[] {
    return Object.freeze(this.options.history.export().map(cloneHistoryEntry));
  }

  public clear(): void {
    this.options.history.clear();
    this.latestRedacted = undefined;
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation += 1;
    this.activeRun?.controller.abort(new EgressDiagnosticsDisposedError());
    this.bestEffort('resource-disposal', () => this.options.stun?.dispose());
    this.disposePromise = this.finishDisposal();
    return this.disposePromise;
  }

  private async executeRun(
    run: ActiveRun,
    input: EgressDiagnosticsCollectInput,
    predecessorCompletion: Promise<void>,
  ): Promise<EgressDiagnosticsLiveResult> {
    let lease: ApplicationNetworkLease | undefined;
    try {
      await this.awaitRun(run, predecessorCompletion);
      this.assertRun(run);

      const applicationLease = await this.acquireExactApplicationLease(run);
      lease = applicationLease;
      this.assertRunLease(run, applicationLease);

      const collectedAt = this.safeNow();
      const publicAddress = await this.awaitRunLease(
        run,
        applicationLease,
        this.track(
          Promise.resolve()
            .then(() => {
              this.assertRunLease(run, applicationLease);
              return this.options.publicAddress.collect({
                leaseCurrent: true,
                signal: run.controller.signal,
              });
            })
            .catch(() => unavailablePublicAddress(collectedAt)),
        ),
      );
      this.assertRunLease(run, applicationLease);

      const baselines = exactBaselines(publicAddress);
      const batch = await this.awaitRunLease(
        run,
        applicationLease,
        this.collectBatch(run, applicationLease, input, baselines, collectedAt),
      );
      this.assertRunLease(run, applicationLease);

      const result: EgressDiagnosticsLiveResult = {
        abuseIpDb: batch.abuseIpDb,
        advisoryOnly: true,
        collectedAt,
        dns: {
          evidence: batch.dns,
          provenance: {
            authoritativeSource: 'injected-approved-service-only',
            publicFallback: false,
            source: 'dns-authoritative',
          },
        },
        generation: run.generation,
        ipinfoMax: batch.ipinfoMax,
        kind: 'egress-diagnostics-live',
        maxMindAnonymousPlus: batch.maxMindAnonymousPlus,
        publicAddress,
        scope: APPLICATION_SCOPE,
        state: overallState(publicAddress, batch),
        stun: batch.stun,
        stunPathSignals: stunPathSignals(baselines, batch.stun),
      };

      this.assertRunLease(run, applicationLease);
      this.bestEffort('history-write', () => this.persistRedacted(result));
      this.assertRunLease(run, applicationLease);
      this.bestEffort('result-publication', () => this.options.onResult?.(result));
      this.assertRunLease(run, applicationLease);
      return result;
    } finally {
      lease?.release();
    }
  }

  private collectBatch(
    run: ActiveRun,
    lease: ApplicationNetworkLease,
    input: EgressDiagnosticsCollectInput,
    baselines: readonly LiveExactEgressAddress[],
    collectedAt: number,
  ): Promise<CollectionBatch> {
    this.assertRunLease(run, lease);
    const ipinfoMax = baselines.map((baseline) =>
      this.track(
        Promise.resolve()
          .then(() => {
            this.assertRunLease(run, lease);
            return this.options.ipinfoMax.collect({
              baseline,
              leaseCurrent: true,
              signal: run.controller.signal,
            });
          })
          .catch(() => unavailableIpinfo(baseline.family, collectedAt)),
      ),
    );
    const maxMindAnonymousPlus = baselines.map((address) =>
      this.track(
        Promise.resolve()
          .then(() => {
            this.assertRunLease(run, lease);
            return this.options.maxMindAnonymousPlus.collect({ address, leaseCurrent: true });
          })
          .catch(() => unavailableMaxMind(address.family, collectedAt)),
      ),
    );
    const abuseIpDb = baselines.map((baseline) =>
      this.track(
        Promise.resolve()
          .then(() => {
            this.assertRunLease(run, lease);
            return this.options.abuseIpDb.collect({
              baseline,
              leaseCurrent: true,
              signal: run.controller.signal,
            });
          })
          .catch(() => unavailableAbuseIpDb(baseline.family, collectedAt)),
      ),
    );
    const dns = this.track(
      Promise.resolve()
        .then(() => {
          this.assertRunLease(run, lease);
          return this.options.dnsCorrelation.collect(run.controller.signal);
        })
        .catch(() => unavailableDns(this.options.dnsCorrelation.hostname, collectedAt)),
    );
    const stun = input.includeStun
      ? this.options.stun
        ? this.track(
            Promise.resolve()
              .then(() => {
                this.assertRunLease(run, lease);
                return this.options.stun?.collect({
                  optIn: true,
                  signal: run.controller.signal,
                });
              })
              .then(normalizeStunEvidence)
              .catch(() => unavailableStun('failed', true)),
          )
        : Promise.resolve(unavailableStun('no-approved-endpoint', true))
      : Promise.resolve(notRequestedStun());

    return Promise.all([
      Promise.all(ipinfoMax),
      Promise.all(maxMindAnonymousPlus),
      Promise.all(abuseIpDb),
      dns,
      stun,
    ]).then(([ipinfo, maxMind, abuse, dnsEvidence, stunEvidence]) => ({
      abuseIpDb: Object.freeze(abuse),
      dns: dnsEvidence,
      ipinfoMax: Object.freeze(ipinfo),
      maxMindAnonymousPlus: Object.freeze(maxMind),
      stun: stunEvidence,
    }));
  }

  private persistRedacted(result: EgressDiagnosticsLiveResult): void {
    const exact: LiveExactEgressAddress[] = [];
    for (const source of result.publicAddress.sources) {
      if (source.address) exact.push(source.address);
    }
    for (const source of [
      ...result.ipinfoMax,
      ...result.maxMindAnonymousPlus,
      ...result.abuseIpDb,
    ]) {
      if (source.address) exact.push(source.address);
    }
    if (result.stun.status === 'available') {
      exact.push(...result.stun.candidates.map(({ address, family }) => ({ address, family })));
    }

    let addresses: readonly PersistedRedactedEgressAddress[] = Object.freeze([]);
    if (exact.length > 0) {
      const suppliedKey = this.options.addressFingerprintKey();
      if (!(suppliedKey instanceof Uint8Array)) {
        throw new Error('The main-owned egress history fingerprint key is unavailable.');
      }
      const key = Uint8Array.from(suppliedKey);
      try {
        addresses = redactEgressAddresses(exact, key);
      } finally {
        key.fill(0);
      }
    }

    const providers = Object.freeze([
      providerSummary('ipify', result.publicAddress.sources),
      providerSummary('ipinfo-max', result.ipinfoMax),
      providerSummary('maxmind-anonymous-plus', result.maxMindAnonymousPlus),
      providerSummary('abuseipdb', result.abuseIpDb),
    ]);
    const entry: EgressHistoryEntry = Object.freeze({
      addresses,
      collectedAt: result.collectedAt,
      kind: 'history',
      providers,
      state: result.state,
    });
    this.latestRedacted = cloneHistoryEntry(entry);
    this.options.history.append(entry);
  }

  private async acquireExactApplicationLease(run: ActiveRun): Promise<ApplicationNetworkLease> {
    let abandoned = false;
    let released = false;
    let resolvedLease: ApplicationNetworkLease | undefined;
    const releaseResolvedLease = (): void => {
      if (!resolvedLease || released) return;
      released = true;
      resolvedLease.release();
    };
    const pending = Promise.resolve().then(() => {
      this.assertRun(run);
      return this.options.acquireNetworkLease(APPLICATION_SCOPE);
    });
    const observed = pending.then((lease) => {
      resolvedLease = lease;
      if (abandoned || !this.isRunCurrent(run)) releaseResolvedLease();
      return lease;
    });
    this.track(
      observed.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      const lease = await this.awaitRun(run, observed);
      this.assertRun(run);
      if (lease.scopes.length !== 1 || lease.scopes[0] !== APPLICATION_SCOPE) {
        releaseResolvedLease();
        throw new EgressDiagnosticsLeaseError();
      }
      this.assertRunLease(run, lease);
      return lease;
    } catch (error) {
      abandoned = true;
      releaseResolvedLease();
      throw error;
    }
  }

  private async awaitRun<T>(run: ActiveRun, work: Promise<T>): Promise<T> {
    this.assertRun(run);
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.abortReason(run));
      run.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([work, cancelled]);
      this.assertRun(run);
      return value;
    } catch (error) {
      this.assertRun(run);
      throw error;
    } finally {
      if (onAbort) run.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async awaitRunLease<T>(
    run: ActiveRun,
    lease: ApplicationNetworkLease,
    work: Promise<T>,
  ): Promise<T> {
    const value = await this.awaitRun(run, work);
    this.assertRunLease(run, lease);
    return value;
  }

  private assertRun(run: ActiveRun): void {
    if (run.controller.signal.aborted) throw this.abortReason(run);
    if (this.disposed) throw new EgressDiagnosticsDisposedError();
    if (run.generation !== this.generation) {
      throw new EgressDiagnosticsSupersededError(run.generation, this.generation);
    }
  }

  private assertRunLease(run: ActiveRun, lease: ApplicationNetworkLease): void {
    this.assertRun(run);
    try {
      lease.assertCurrent();
    } catch (error) {
      throw new EgressDiagnosticsSupersededError(run.generation, this.generation, error);
    }
    this.assertRun(run);
  }

  private abortReason(run: ActiveRun): Error {
    const reason = run.controller.signal.reason;
    if (reason instanceof Error) return reason;
    return run.generation === this.generation
      ? new EgressDiagnosticsCancelledError()
      : new EgressDiagnosticsSupersededError(run.generation, this.generation);
  }

  private isRunCurrent(run: ActiveRun): boolean {
    return !this.disposed && !run.controller.signal.aborted && run.generation === this.generation;
  }

  private safeNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('The egress diagnostic clock is invalid.');
    }
    return value;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    );
    return task;
  }

  private bestEffort(
    phase: 'history-write' | 'result-publication' | 'resource-disposal',
    operation: () => void,
  ): void {
    try {
      operation();
    } catch (error) {
      try {
        this.options.onObservabilityError?.(phase, error);
      } catch {
        // Advisory observability cannot replace the authoritative live diagnostic result.
      }
    }
  }

  private async finishDisposal(): Promise<void> {
    await this.activeRun?.completion;
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    try {
      await this.options.maxMindAnonymousPlus.close?.();
    } catch (error) {
      this.bestEffort('resource-disposal', () => {
        throw error;
      });
    }
  }
}
