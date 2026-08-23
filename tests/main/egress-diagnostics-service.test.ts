import { describe, expect, it, vi } from 'vitest';
import type { ApplicationNetworkLease } from '../../src/main/proxy/application-proxy-coordinator';
import type {
  EgressAddressFamily,
  EgressEvidenceAssessment,
  EgressHistoryEntry,
  EgressLiveSourceEvidence,
  EgressProviderId,
  EgressTransportId,
  LiveExactEgressAddress,
} from '../../src/shared/contracts/egress-diagnostics';
import type { AbuseIpDbEvidence } from '../../src/main/egress-diagnostics/adapters/abuseipdb';
import { createIpinfoMaxAdapter } from '../../src/main/egress-diagnostics/adapters/ipinfo-max';
import type { IpinfoMaxEvidence } from '../../src/main/egress-diagnostics/adapters/ipinfo-max';
import type { MaxMindAnonymousPlusEvidence } from '../../src/main/egress-diagnostics/adapters/maxmind-anonymous-plus';
import type {
  StunCollectionRequest,
  StunDiagnosticResult,
} from '../../src/main/egress-diagnostics/webrtc/stun-collector';
import type {
  DnsEvidenceCollection,
  DnsEvidenceState,
} from '../../src/main/egress-diagnostics/collectors/dns-correlation-types';
import type {
  PublicAddressCollection,
  PublicAddressEvidence,
} from '../../src/main/egress-diagnostics/collectors/public-address';
import { deriveEvidenceAssessment } from '../../src/main/egress-diagnostics/evidence-policy';
import {
  EgressDiagnosticsCancelledError,
  EgressDiagnosticsDisposedError,
  EgressDiagnosticsLeaseError,
  EgressDiagnosticsService,
  EgressDiagnosticsSupersededError,
  type EgressDiagnosticsServiceOptions,
} from '../../src/main/egress-diagnostics/service';

const NOW = Date.UTC(2026, 7, 20, 12);
const IPV4 = '1.1.1.1';
const IPV6 = '2606:4700:4700::1111';
const FINGERPRINT_KEY = Buffer.alloc(32, 0x52);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const assessment = (
  address: string,
  transport: EgressTransportId = 'electron-net:application-session',
): EgressEvidenceAssessment =>
  deriveEvidenceAssessment({
    collectionState: 'complete',
    comparisonKeys: [address, address],
    leaseCurrent: true,
    sourceFreshness: 'live',
    strictParse: true,
    transport,
  });

const completeSource = (
  provider: EgressProviderId,
  address: LiveExactEgressAddress,
  transport: EgressTransportId = 'electron-net:application-session',
): EgressLiveSourceEvidence & { readonly provider: EgressProviderId } => ({
  address,
  assessment: assessment(address.address, transport),
  explanation: { facts: [], recommendations: [], summary: `${provider} complete` },
  family: address.family,
  kind: 'live-source',
  provider,
  provenance: {
    collectedAt: NOW,
    provider,
    sourceTimes: [],
    transport,
  },
  state: 'complete',
});

const completePublicSource = (
  family: EgressAddressFamily,
  address: string,
): PublicAddressEvidence => ({
  ...completeSource('ipify', { address, family }),
  provider: 'ipify',
  provenance: {
    collectedAt: NOW,
    endpointId: family === 'ipv4' ? 'public-address-v4' : 'public-address-v6',
    provider: 'ipify',
    sourceTimes: [],
    transport: 'electron-net:application-session',
  },
});

const publicCollection = (ipv4 = IPV4, ipv6 = IPV6): PublicAddressCollection => {
  const sources = [completePublicSource('ipv4', ipv4), completePublicSource('ipv6', ipv6)] as const;
  return {
    assessment: deriveEvidenceAssessment({
      collectionState: 'complete',
      comparisonKeys: [ipv4, ipv4],
      leaseCurrent: true,
      sourceFreshness: 'live',
      strictParse: true,
      transport: 'electron-net:application-session',
    }),
    collectedAt: NOW,
    explanation: { facts: [], recommendations: [], summary: 'public complete' },
    kind: 'live-report',
    sources,
    state: 'complete',
  };
};

const ipinfoEvidence = (baseline: LiveExactEgressAddress): IpinfoMaxEvidence => ({
  ...completeSource('ipinfo-max', baseline),
  provider: 'ipinfo-max',
});

const maxMindEvidence = (address: LiveExactEgressAddress): MaxMindAnonymousPlusEvidence => ({
  ...completeSource('maxmind-anonymous-plus', address, 'local:maxmind-mmdb'),
  provider: 'maxmind-anonymous-plus',
});

const abuseEvidence = (baseline: LiveExactEgressAddress): AbuseIpDbEvidence => ({
  ...completeSource('abuseipdb', baseline),
  provider: 'abuseipdb',
  rateLimit: {},
});

const dnsEvidence = (
  authoritativeState: DnsEvidenceCollection['authoritativeCorrelation']['state'] = 'correlated',
  laneState: DnsEvidenceState = 'observed',
): DnsEvidenceCollection => ({
  advisoryOnly: true,
  authoritativeCorrelation: {
    attribution: 'application-session-request-correlation-only',
    ecs: { observed: false },
    lane: 'authoritative-application-request-correlation',
    observedAt: NOW,
    proxyDestinationDnsRoutingEstablished: false,
    recursiveResolvers:
      authoritativeState === 'correlated' ? [{ address: '9.9.9.9', family: 'ipv4' }] : [],
    sourceTime: NOW,
    state: authoritativeState,
  },
  collectedAt: NOW,
  osResolverConfiguration: {
    applicationRequestCorrelationEstablished: false,
    dnsOverHttps: 'automatic',
    electronSessionResolutionEstablished: false,
    lane: 'os-resolver-configuration',
    observedAt: NOW,
    proxyDestinationDnsRoutingEstablished: false,
    resolverAddresses: [{ address: '192.0.2.53', family: 'ipv4' }],
    state: laneState,
    weight: 'supporting-only',
  },
  preflightDisposition: 'unchanged',
  sessionResolverObservation: {
    addresses: [{ address: '93.184.216.34', family: 'ipv4' }],
    applicationRequestCorrelationEstablished: false,
    hostname: 'diagnostic.example.test',
    lane: 'electron-application-session-resolver',
    observedAt: NOW,
    proxyDestinationDnsRoutingEstablished: false,
    state: laneState,
    weight: 'session-resolver-observation-only',
  },
});

interface LeaseFixture {
  readonly assertCurrent: ReturnType<typeof vi.fn>;
  readonly lease: ApplicationNetworkLease;
  readonly release: ReturnType<typeof vi.fn>;
}

const leaseFixture = (
  scopes: ApplicationNetworkLease['scopes'] = ['application'],
): LeaseFixture => {
  let released = false;
  const assertCurrent = vi.fn(() => {
    if (released) throw new Error('released lease');
  });
  const release = vi.fn(() => {
    released = true;
  });
  return {
    assertCurrent,
    lease: {
      assertCurrent,
      epochs: Object.freeze({ application: 'application-epoch' }),
      release,
      scopes,
    },
    release,
  };
};

interface HistoryFixture {
  readonly entries: EgressHistoryEntry[];
  readonly history: EgressDiagnosticsServiceOptions['history'];
}

const historyFixture = (): HistoryFixture => {
  const entries: EgressHistoryEntry[] = [];
  return {
    entries,
    history: {
      append: (entry) => {
        entries.push(entry);
        return entry;
      },
      clear: () => {
        entries.splice(0);
      },
      export: () => entries,
    },
  };
};

const serviceFixture = (
  overrides: Partial<EgressDiagnosticsServiceOptions> = {},
): {
  readonly history: HistoryFixture;
  readonly lease: LeaseFixture;
  readonly options: EgressDiagnosticsServiceOptions;
} => {
  const lease = leaseFixture();
  const history = historyFixture();
  let acquisitionCount = 0;
  const options: EgressDiagnosticsServiceOptions = {
    abuseIpDb: { collect: async ({ baseline }) => abuseEvidence(baseline) },
    acquireNetworkLease: async () => {
      acquisitionCount += 1;
      return acquisitionCount === 1 ? lease.lease : leaseFixture().lease;
    },
    addressFingerprintKey: () => Uint8Array.from(FINGERPRINT_KEY),
    dnsCorrelation: {
      collect: async () => dnsEvidence(),
      hostname: 'diagnostic.example.test',
    },
    history: history.history,
    ipinfoMax: { collect: async ({ baseline }) => ipinfoEvidence(baseline) },
    maxMindAnonymousPlus: {
      close: async () => undefined,
      collect: async ({ address }) => maxMindEvidence(address),
    },
    now: () => NOW,
    publicAddress: { collect: async () => publicCollection() },
    ...overrides,
  };
  return { history, lease, options };
};

describe('EgressDiagnosticsService', () => {
  it('supersedes overlapping runs, promptly releases the obsolete exact application lease, and publishes only the winner', async () => {
    const firstPublic = deferred<PublicAddressCollection>();
    const leases = [leaseFixture(), leaseFixture()];
    const acquireScopes: string[] = [];
    let publicCalls = 0;
    const published: number[] = [];
    const history = historyFixture();
    const fixture = serviceFixture({
      acquireNetworkLease: async (scope) => {
        acquireScopes.push(scope);
        return leases[acquireScopes.length - 1]!.lease;
      },
      history: history.history,
      onResult: (result) => published.push(result.generation),
      publicAddress: {
        collect: async () => {
          publicCalls += 1;
          return publicCalls === 1 ? firstPublic.promise : publicCollection();
        },
      },
    });
    const service = new EgressDiagnosticsService(fixture.options);

    const first = service.collect({ includeStun: false, scope: 'application' });
    await vi.waitFor(() => expect(publicCalls).toBe(1));
    const second = service.collect({ includeStun: false, scope: 'application' });

    await expect(first).rejects.toBeInstanceOf(EgressDiagnosticsSupersededError);
    expect(leases[0]!.release).toHaveBeenCalledTimes(1);
    const winner = await second;

    expect(winner.generation).toBe(2);
    expect(acquireScopes).toEqual(['application', 'application']);
    expect(leases[1]!.release).toHaveBeenCalledTimes(1);
    expect(leases[0]!.assertCurrent.mock.calls.length).toBeGreaterThan(1);
    expect(leases[1]!.assertCurrent.mock.calls.length).toBeGreaterThan(5);
    expect(published).toEqual([2]);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.collectedAt).toBe(NOW);

    firstPublic.resolve(publicCollection('8.8.4.4', IPV6));
    await firstPublic.promise;
    expect(published).toEqual([2]);
    expect(history.entries).toHaveLength(1);
    await service.dispose();
  });

  it('treats external cancellation as authoritative and releases the lease before non-cooperative work settles', async () => {
    const pendingPublic = deferred<PublicAddressCollection>();
    const fixture = serviceFixture({
      publicAddress: { collect: async () => pendingPublic.promise },
    });
    const service = new EgressDiagnosticsService(fixture.options);
    const controller = new AbortController();
    const collection = service.collect({
      includeStun: false,
      scope: 'application',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fixture.lease.assertCurrent).toHaveBeenCalled());

    controller.abort();

    await expect(collection).rejects.toBeInstanceOf(EgressDiagnosticsCancelledError);
    expect(fixture.lease.release).toHaveBeenCalledTimes(1);
    expect(fixture.history.entries).toEqual([]);

    pendingPublic.resolve(publicCollection());
    await pendingPublic.promise;
    await service.dispose();
  });

  it('cancels a pending lease acquisition, starts no collectors, and releases the late lease exactly once', async () => {
    const pendingLease = deferred<ApplicationNetworkLease>();
    const lateLease = leaseFixture();
    const acquireNetworkLease = vi.fn(async () => pendingLease.promise);
    const publicCollect = vi.fn(async () => publicCollection());
    const fixture = serviceFixture({
      acquireNetworkLease,
      publicAddress: { collect: publicCollect },
    });
    const service = new EgressDiagnosticsService(fixture.options);
    const controller = new AbortController();
    const collection = service.collect({
      includeStun: false,
      scope: 'application',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(acquireNetworkLease).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(collection).rejects.toBeInstanceOf(EgressDiagnosticsCancelledError);
    expect(publicCollect).not.toHaveBeenCalled();
    expect(fixture.history.entries).toEqual([]);

    pendingLease.resolve(lateLease.lease);
    await vi.waitFor(() => expect(lateLease.release).toHaveBeenCalledTimes(1));
    await service.dispose();
    expect(lateLease.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a lease broader than exact application scope and releases it once', async () => {
    const broadLease = leaseFixture(['application', 'conversation']);
    const fixture = serviceFixture({ acquireNetworkLease: async () => broadLease.lease });
    const service = new EgressDiagnosticsService(fixture.options);

    await expect(
      service.collect({ includeStun: false, scope: 'application' }),
    ).rejects.toBeInstanceOf(EgressDiagnosticsLeaseError);
    expect(broadLease.release).toHaveBeenCalledTimes(1);
    expect(fixture.history.entries).toEqual([]);
    await service.dispose();
  });

  it('keeps a history write failure observational and still returns and publishes the same live result', async () => {
    const publication: unknown[] = [];
    const observability: string[] = [];
    const fixture = serviceFixture({
      history: {
        append: () => {
          throw new Error('injected history failure');
        },
        clear: () => undefined,
        export: () => [],
      },
      onObservabilityError: (phase) => observability.push(phase),
      onResult: (result) => publication.push(result),
    });
    const service = new EgressDiagnosticsService(fixture.options);

    const result = await service.collect({ includeStun: false, scope: 'application' });

    expect(result.state).toBe('complete');
    expect(publication).toEqual([result]);
    expect(observability).toContain('history-write');
    const latest = service.getLatestRedacted();
    expect(latest?.addresses).toHaveLength(2);
    expect(JSON.stringify(latest)).not.toContain(IPV4);
    expect(JSON.stringify(latest)).not.toContain(IPV6);
    expect(JSON.stringify(latest)).not.toContain('9.9.9.9');
    expect(latest?.addresses.every((address) => address.fingerprint.startsWith('eaf1_'))).toBe(
      true,
    );
    await service.dispose();
  });

  it('turns optional credentials and source outages into partial advisory evidence without access or launch authority', async () => {
    const missingCredential = createIpinfoMaxAdapter({
      now: () => NOW,
      request: async () => {
        throw new Error('request must not run without a credential');
      },
      token: () => undefined,
    });
    const fixture = serviceFixture({
      dnsCorrelation: {
        collect: async () => dnsEvidence('unavailable', 'partial'),
        hostname: 'diagnostic.example.test',
      },
      ipinfoMax: missingCredential,
      maxMindAnonymousPlus: {
        collect: async () => {
          throw new Error('database unavailable');
        },
      },
    });
    const service = new EgressDiagnosticsService(fixture.options);

    const result = await service.collect({ includeStun: false, scope: 'application' });

    expect(result.advisoryOnly).toBe(true);
    expect(result.state).toBe('partial');
    expect(result.ipinfoMax.map((source) => source.issue?.code)).toEqual([
      'missing-credential',
      'missing-credential',
    ]);
    expect(result.maxMindAnonymousPlus.every((source) => source.state === 'unavailable')).toBe(
      true,
    );
    expect(result.dns.evidence.preflightDisposition).toBe('unchanged');
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:allowed|eligibility|featureAccess|launchEligible|preflightBlocked)"/i,
    );
    const stored = fixture.history.entries[0];
    expect(stored?.state).toBe('partial');
    expect(stored?.providers.find((provider) => provider.provider === 'ipinfo-max')?.state).toBe(
      'unavailable',
    );
    expect(
      stored?.providers.find((provider) => provider.provider === 'maxmind-anonymous-plus')?.state,
    ).toBe('unavailable');
    await service.dispose();
  });

  it('uses only explicit trusted STUN opt-in, preserves diagnostic scope, and signals same-family differences as path mismatch rather than proxy egress', async () => {
    const collectStun = vi.fn(
      async (_request: StunCollectionRequest): Promise<StunDiagnosticResult> => ({
        candidates: [
          { address: '8.8.8.8', family: 'ipv4', transport: 'udp' },
          { address: IPV6, family: 'ipv6', transport: 'udp' },
          { address: '10.0.0.1', family: 'ipv4', transport: 'udp' },
          { address: '8.8.8.8', family: 'ipv6', transport: 'tcp' },
          { address: '3fff::1', family: 'ipv6', transport: 'tcp' },
        ],
        scope: 'diagnostic-window-only',
        status: 'available',
      }),
    );
    const fixture = serviceFixture({
      stun: { collect: collectStun, dispose: vi.fn() },
    });
    const service = new EgressDiagnosticsService(fixture.options);

    const optedIn = await service.collect({ includeStun: true, scope: 'application' });

    expect(collectStun).toHaveBeenCalledTimes(1);
    expect(collectStun.mock.calls[0]?.[0].optIn).toBe(true);
    expect(optedIn.stun.scope).toBe('diagnostic-window-only');
    expect(optedIn.stun.provenance).toMatchObject({
      explicitTrustedOptIn: true,
      proxyEgressAttribution: false,
      source: 'webrtc-stun',
    });
    expect(optedIn.stun.status).toBe('available');
    if (optedIn.stun.status === 'available') {
      expect(optedIn.stun.candidates.map((candidate) => candidate.address)).toEqual([
        '8.8.8.8',
        IPV6,
      ]);
    }
    expect(optedIn.stunPathSignals).toEqual([
      {
        family: 'ipv4',
        interpretation: 'possible-leak-or-path-mismatch',
        kind: 'stun-address-difference',
        proxyEgressAttribution: false,
        transport: 'udp',
      },
    ]);
    expect(optedIn.dns.provenance).toEqual({
      authoritativeSource: 'injected-approved-service-only',
      publicFallback: false,
      source: 'dns-authoritative',
    });
    const persisted = service.getLatestRedacted();
    expect(JSON.stringify(persisted)).not.toContain('8.8.8.8');
    expect(JSON.stringify(persisted)).not.toContain('3fff::1');

    const notOptedIn = await service.collect({ includeStun: false, scope: 'application' });
    expect(collectStun).toHaveBeenCalledTimes(1);
    expect(notOptedIn.stun).toMatchObject({
      scope: 'diagnostic-window-only',
      status: 'not-requested',
    });
    await service.dispose();
  });

  it('fails closed on unexpected STUN scope and never treats it as application-session proxy egress', async () => {
    const fixture = serviceFixture({
      stun: {
        collect: async () =>
          ({
            candidates: [{ address: '8.8.8.8', family: 'ipv4', transport: 'udp' }],
            scope: 'application',
            status: 'available',
          }) as unknown as StunDiagnosticResult,
        dispose: vi.fn(),
      },
    });
    const service = new EgressDiagnosticsService(fixture.options);

    const result = await service.collect({ includeStun: true, scope: 'application' });

    expect(result.stun).toMatchObject({
      provenance: { proxyEgressAttribution: false },
      reason: 'failed',
      scope: 'diagnostic-window-only',
      status: 'unavailable',
    });
    expect(result.stunPathSignals).toEqual([]);
    expect(result.state).toBe('partial');
    await service.dispose();
  });

  it('dispose cancels active work, releases its lease, disposes STUN, closes MaxMind, and rejects later runs', async () => {
    const pendingPublic = deferred<PublicAddressCollection>();
    const stunDispose = vi.fn();
    const maxMindClose = vi.fn(async () => undefined);
    const fixture = serviceFixture({
      maxMindAnonymousPlus: {
        close: maxMindClose,
        collect: async ({ address }) => maxMindEvidence(address),
      },
      publicAddress: { collect: async () => pendingPublic.promise },
      stun: {
        collect: async () => ({
          scope: 'diagnostic-window-only',
          status: 'unavailable',
          reason: 'failed',
        }),
        dispose: stunDispose,
      },
    });
    const service = new EgressDiagnosticsService(fixture.options);
    const active = service.collect({ includeStun: true, scope: 'application' });
    await vi.waitFor(() => expect(fixture.lease.assertCurrent).toHaveBeenCalled());

    const disposal = service.dispose();

    await expect(active).rejects.toBeInstanceOf(EgressDiagnosticsDisposedError);
    expect(fixture.lease.release).toHaveBeenCalledTimes(1);
    expect(stunDispose).toHaveBeenCalledTimes(1);
    expect(maxMindClose).not.toHaveBeenCalled();

    pendingPublic.resolve(publicCollection());
    await disposal;
    expect(maxMindClose).toHaveBeenCalledTimes(1);
    await expect(
      service.collect({ includeStun: false, scope: 'application' }),
    ).rejects.toBeInstanceOf(EgressDiagnosticsDisposedError);
  });
});
