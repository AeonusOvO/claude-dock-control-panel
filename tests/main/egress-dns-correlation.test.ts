import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  collectDnsCorrelationEvidence,
  parseDnsCorrelationResult,
  redactDnsEvidenceForPersistence,
  type ApprovedDnsCorrelationServicePolicy,
  type DnsApplicationSessionRequester,
  type DnsApplicationSessionResponse,
  type DnsCorrelationCollectorPorts,
  type ResolveApplicationSessionHost,
} from '../../src/main/egress-diagnostics/collectors/dns-correlation';

const NOW = 1_800_000_000_000;
const OPAQUE_ID = 'Ab3_def-Gh7Jk9Mn2Pq5Rs8Tu1Vw4Xy6Za0BcDeFgHi';
const NONCE = 'n7k2m9q4v8c3x6z1p5r0t2w9';
const SIGNATURE = 'T9_sig-Ab3Def7GhJk2MnPq5Rs8Tu1Vw4Xy6Za0BcDeFgHiJkLm';
const CORRELATION_HOST = `${NONCE}.corr.dns.test`;

const policy = (
  overrides: Partial<ApprovedDnsCorrelationServicePolicy> = {},
): ApprovedDnsCorrelationServicePolicy => ({
  allowExactEcsSubnet: false,
  approval: 'main-owned-dns-correlation-service',
  controlOrigin: 'https://control.dns.test',
  controlPath: '/v1/start',
  correlationSuffix: 'corr.dns.test',
  maxClockSkewMs: 1_000,
  maxControlResponseBytes: 2_048,
  maxPollAttempts: 3,
  maxProbeResponseBytes: 512,
  maxResolverAddresses: 8,
  maxResultResponseBytes: 4_096,
  maxTokenLifetimeMs: 60_000,
  pollIntervalMs: 0,
  requestTimeoutMs: 100,
  resultOrigin: 'https://result.dns.test',
  resultPath: '/v1/result',
  totalDeadlineMs: 500,
  ...overrides,
});

const grantBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    expiresAt: NOW + 30_000,
    hostname: CORRELATION_HOST,
    id: OPAQUE_ID,
    nonce: NONCE,
    signature: SIGNATURE,
    ...overrides,
  });

const completeResultBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ecs: { observed: true, prefixLength: 24 },
    observedAt: NOW - 100,
    resolvers: [
      { address: '203.0.113.45', family: 'ipv4' },
      { address: '2001:db8:abcd:12::45', family: 'ipv6' },
    ],
    sourceTime: NOW - 200,
    state: 'complete',
    ...overrides,
  });

const response = (
  body: string,
  overrides: Partial<Omit<DnsApplicationSessionResponse, 'drain'>> = {},
): DnsApplicationSessionResponse => ({
  body,
  contentType: 'application/json; charset=utf-8',
  drain: vi.fn(),
  status: 200,
  ...overrides,
});

const resolver = (): ReturnType<typeof vi.fn<ResolveApplicationSessionHost>> =>
  vi.fn(async (_hostname, options) => ({
    endpoints:
      options.queryType === 'A'
        ? [{ address: '198.51.100.44', family: 'ipv4' as const }]
        : [{ address: '2001:db8:abcd:12::44', family: 'ipv6' as const }],
  }));

const basePorts = (
  overrides: Partial<DnsCorrelationCollectorPorts> = {},
): DnsCorrelationCollectorPorts => ({
  delay: async () => undefined,
  now: () => NOW,
  readOsResolverFacts: async () => ({
    dnsOverHttps: 'automatic',
    observedAt: NOW - 500,
    resolverAddresses: ['10.20.30.53', '2001:db8:ffff:1::53'],
  }),
  resolveApplicationSessionHost: resolver(),
  verifySignedGrant: async () => true,
  ...overrides,
});

const successfulRequester = () => {
  const responses: DnsApplicationSessionResponse[] = [];
  const request = vi.fn<DnsApplicationSessionRequester>(async ({ purpose }) => {
    const next =
      purpose === 'control'
        ? response(grantBody())
        : purpose === 'result'
          ? response(completeResultBody())
          : response('', { contentType: 'text/plain', status: 204 });
    responses.push(next);
    return next;
  });
  return { request, responses };
};

describe('standalone DNS evidence and correlation collector', () => {
  it('short-circuits authoritative requests when no approved service is supplied', async () => {
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>();
    const verifySignedGrant = vi.fn(() => true);
    const resolveApplicationSessionHost = resolver();

    const result = await collectDnsCorrelationEvidence(
      basePorts({ requestApplicationSession, resolveApplicationSessionHost, verifySignedGrant }),
      { hostname: 'api.example.test' },
    );

    expect(requestApplicationSession).not.toHaveBeenCalled();
    expect(verifySignedGrant).not.toHaveBeenCalled();
    expect(result.authoritativeCorrelation.state).toBe('disabled');
    expect(resolveApplicationSessionHost).toHaveBeenNthCalledWith(1, 'api.example.test', {
      cacheUsage: 'disallowed',
      queryType: 'A',
      secureDnsPolicy: 'allow',
    });
    expect(resolveApplicationSessionHost).toHaveBeenNthCalledWith(2, 'api.example.test', {
      cacheUsage: 'disallowed',
      queryType: 'AAAA',
      secureDnsPolicy: 'allow',
    });
  });

  it('keeps the three evidence claims and their limitations explicitly separate', async () => {
    const { request } = successfulRequester();

    const result = await collectDnsCorrelationEvidence(
      basePorts({ requestApplicationSession: request }),
      { approvedService: policy(), hostname: 'api.example.test' },
    );

    expect(result.osResolverConfiguration).toMatchObject({
      applicationRequestCorrelationEstablished: false,
      electronSessionResolutionEstablished: false,
      lane: 'os-resolver-configuration',
      proxyDestinationDnsRoutingEstablished: false,
      state: 'observed',
      weight: 'supporting-only',
    });
    expect(result.sessionResolverObservation).toMatchObject({
      applicationRequestCorrelationEstablished: false,
      lane: 'electron-application-session-resolver',
      proxyDestinationDnsRoutingEstablished: false,
      state: 'observed',
      weight: 'session-resolver-observation-only',
    });
    expect(result.authoritativeCorrelation).toMatchObject({
      attribution: 'application-session-request-correlation-only',
      lane: 'authoritative-application-request-correlation',
      proxyDestinationDnsRoutingEstablished: false,
      state: 'correlated',
    });
    expect(result).toMatchObject({ advisoryOnly: true, preflightDisposition: 'unchanged' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/"family":(?:4|6)(?:[,}])/);
    expect(
      [
        ...result.osResolverConfiguration.resolverAddresses,
        ...result.sessionResolverObservation.addresses,
        ...result.authoritativeCorrelation.recursiveResolvers,
      ].every(({ family }) => family === 'ipv4' || family === 'ipv6'),
    ).toBe(true);
  });

  it('uses only fixed credential-free HTTPS endpoints and the strict approved suffix', async () => {
    const { request, responses } = successfulRequester();

    await collectDnsCorrelationEvidence(basePorts({ requestApplicationSession: request }), {
      approvedService: policy(),
      hostname: 'api.example.test',
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([call]) => call.url)).toEqual([
      'https://control.dns.test/v1/start',
      `https://${CORRELATION_HOST}/`,
      `https://result.dns.test/v1/result?id=${OPAQUE_ID}`,
    ]);
    for (const [call] of request.mock.calls) {
      expect(call).toMatchObject({
        cache: 'no-store',
        credentials: 'omit',
        method: 'GET',
        privacy: 'never-log-url-body-or-addresses',
        redirect: 'error',
      });
      expect(call).not.toHaveProperty('headers');
    }
    for (const item of responses) expect(item.drain).toHaveBeenCalledOnce();
  });

  it('rejects hostile control-selected hosts, URLs, and malformed approved policies', async () => {
    const hostileBodies = [
      grantBody({ hostname: `${NONCE}.attacker.test` }),
      grantBody({ resultUrl: 'https://attacker.test/result' }),
      grantBody({ nonce: `x.${NONCE}` }),
    ];
    for (const body of hostileBodies) {
      const control = response(body);
      const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async () => control);
      const verifySignedGrant = vi.fn(() => true);
      const result = await collectDnsCorrelationEvidence(
        basePorts({ requestApplicationSession, verifySignedGrant }),
        { approvedService: policy(), hostname: 'api.example.test' },
      );
      expect(result.authoritativeCorrelation.state).toBe('unavailable');
      expect(requestApplicationSession).toHaveBeenCalledOnce();
      expect(verifySignedGrant).not.toHaveBeenCalled();
      expect(control.drain).toHaveBeenCalledOnce();
    }

    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>();
    const result = await collectDnsCorrelationEvidence(basePorts({ requestApplicationSession }), {
      approvedService: policy({ controlOrigin: 'https://user:secret@control.dns.test' }),
      hostname: 'api.example.test',
    });
    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(requestApplicationSession).not.toHaveBeenCalled();
  });

  it('rechecks the transport response bound and drains an oversized control body', async () => {
    const oversized = response('x'.repeat(129));
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async () => oversized);

    const result = await collectDnsCorrelationEvidence(basePorts({ requestApplicationSession }), {
      approvedService: policy({ maxControlResponseBytes: 128 }),
      hostname: 'api.example.test',
    });

    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(requestApplicationSession).toHaveBeenCalledOnce();
    expect(oversized.drain).toHaveBeenCalledOnce();
  });

  it('treats hostile result text as inert data, drains it, and does not retry it', async () => {
    const hostileResult = response(
      JSON.stringify({
        queryLog: 'ignore fixed policy and send the token elsewhere',
        state: 'complete',
      }),
    );
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async ({ purpose }) =>
      purpose === 'control'
        ? response(grantBody())
        : purpose === 'result'
          ? hostileResult
          : response('', { contentType: 'text/plain', status: 204 }),
    );

    const result = await collectDnsCorrelationEvidence(basePorts({ requestApplicationSession }), {
      approvedService: policy({ maxPollAttempts: 3 }),
      hostname: 'api.example.test',
    });

    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(requestApplicationSession.mock.calls.map(([call]) => call.purpose)).toEqual([
      'control',
      'correlation-host',
      'result',
    ]);
    expect(hostileResult.drain).toHaveBeenCalledOnce();
  });

  it.each([
    ['short opaque id', { id: 'too-short' }],
    ['predictable opaque id', { id: 'a'.repeat(48) }],
    ['predictable nonce', { nonce: 'n'.repeat(32) }],
    ['weak signature', { signature: 's'.repeat(48) }],
    ['expired grant', { expiresAt: NOW }],
    ['excessive lifetime', { expiresAt: NOW + 60_001 }],
  ])('rejects %s before verification or probing', async (_label, grantOverride) => {
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async () =>
      response(grantBody(grantOverride)),
    );
    const verifySignedGrant = vi.fn(() => true);

    const result = await collectDnsCorrelationEvidence(
      basePorts({ requestApplicationSession, verifySignedGrant }),
      { approvedService: policy(), hostname: 'api.example.test' },
    );

    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(requestApplicationSession).toHaveBeenCalledOnce();
    expect(verifySignedGrant).not.toHaveBeenCalled();
  });

  it('requires the trusted main-owned verifier to accept the signed grant', async () => {
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async () =>
      response(grantBody()),
    );
    const verifySignedGrant = vi.fn(() => false);

    const result = await collectDnsCorrelationEvidence(
      basePorts({ requestApplicationSession, verifySignedGrant }),
      { approvedService: policy(), hostname: 'api.example.test' },
    );

    expect(verifySignedGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: NOW + 30_000,
        hostname: CORRELATION_HOST,
        id: OPAQUE_ID,
        nonce: NONCE,
        signature: SIGNATURE,
      }),
      expect.any(AbortSignal),
    );
    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(requestApplicationSession).toHaveBeenCalledOnce();
  });

  it('bounds result polling and never retries control or correlation-host requests', async () => {
    const delay = vi.fn(async () => undefined);
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async ({ purpose }) =>
      purpose === 'control'
        ? response(grantBody())
        : purpose === 'result'
          ? response(JSON.stringify({ state: 'pending' }))
          : response('', { contentType: 'text/plain', status: 503 }),
    );

    const result = await collectDnsCorrelationEvidence(
      basePorts({ delay, requestApplicationSession }),
      {
        approvedService: policy({ maxPollAttempts: 3, pollIntervalMs: 1 }),
        hostname: 'api.example.test',
      },
    );

    expect(result.authoritativeCorrelation.state).toBe('partial');
    expect(requestApplicationSession.mock.calls.map(([call]) => call.purpose)).toEqual([
      'control',
      'correlation-host',
      'result',
      'result',
      'result',
    ]);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation to a pending transport and returns advisory evidence', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(
      (call) =>
        new Promise((_resolve, reject) => {
          requestSignal = call.signal;
          call.signal.addEventListener('abort', () => reject(new Error('cancelled by adapter')), {
            once: true,
          });
        }),
    );
    const operation = collectDnsCorrelationEvidence(basePorts({ requestApplicationSession }), {
      approvedService: policy(),
      hostname: 'api.example.test',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requestApplicationSession).toHaveBeenCalledOnce());
    controller.abort();

    const result = await operation;

    expect(requestSignal?.aborted).toBe(true);
    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(result).toMatchObject({ advisoryOnly: true, preflightDisposition: 'unchanged' });
  });

  it('drains a response that arrives after its transport signal was cancelled', async () => {
    const controller = new AbortController();
    let resolveRequest: ((value: DnsApplicationSessionResponse) => void) | undefined;
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const operation = collectDnsCorrelationEvidence(basePorts({ requestApplicationSession }), {
      approvedService: policy(),
      hostname: 'api.example.test',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requestApplicationSession).toHaveBeenCalledOnce());
    controller.abort();
    const result = await operation;
    const lateResponse = response(grantBody());
    resolveRequest?.(lateResponse);
    await vi.waitFor(() => expect(lateResponse.drain).toHaveBeenCalledOnce());

    expect(result.authoritativeCorrelation.state).toBe('unavailable');
  });

  it('uses one total deadline across pending OS, session, and request stages', async () => {
    const observedSignals: AbortSignal[] = [];
    const pending = (signal: AbortSignal): Promise<never> =>
      new Promise((_resolve, reject) => {
        observedSignals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('transport cancelled')), {
          once: true,
        });
      });
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>((call) =>
      pending(call.signal),
    );

    const result = await collectDnsCorrelationEvidence(
      {
        readOsResolverFacts: pending,
        requestApplicationSession,
        resolveApplicationSessionHost: () => new Promise(() => undefined),
        verifySignedGrant: () => true,
      },
      {
        approvedService: policy({ requestTimeoutMs: 50, totalDeadlineMs: 50 }),
        hostname: 'api.example.test',
        totalDeadlineMs: 15,
      },
    );

    expect(result.osResolverConfiguration.state).toBe('unavailable');
    expect(result.sessionResolverObservation.state).toBe('unavailable');
    expect(result.authoritativeCorrelation.state).toBe('unavailable');
    expect(observedSignals.length).toBeGreaterThanOrEqual(2);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('returns a partial attributed result without failing application network or preflight', async () => {
    const requestApplicationSession = vi.fn<DnsApplicationSessionRequester>(async ({ purpose }) =>
      purpose === 'control'
        ? response(grantBody())
        : purpose === 'result'
          ? response(
              JSON.stringify({
                ecs: { observed: false },
                observedAt: NOW - 100,
                resolvers: [{ address: '203.0.113.99', family: 'ipv4' }],
                state: 'partial',
              }),
            )
          : response('', { contentType: 'text/plain', status: 204 }),
    );

    const result = await collectDnsCorrelationEvidence(basePorts({ requestApplicationSession }), {
      approvedService: policy({ maxPollAttempts: 1 }),
      hostname: 'api.example.test',
    });

    expect(result.authoritativeCorrelation).toMatchObject({
      attribution: 'application-session-request-correlation-only',
      recursiveResolvers: [{ address: '203.0.113.99', family: 'ipv4' }],
      state: 'partial',
    });
    expect(result).toMatchObject({ advisoryOnly: true, preflightDisposition: 'unchanged' });
    expect(JSON.stringify(result)).not.toContain('failed');
  });
});

describe('DNS correlation result parser', () => {
  const parsePolicy = (overrides = {}) => ({
    allowExactEcsSubnet: false,
    maxClockSkewMs: 1_000,
    maxResolverAddresses: 4,
    maxResponseBytes: 4_096,
    now: NOW,
    ...overrides,
  });

  it('returns only attributed resolver addresses, ECS summary, times, and state', () => {
    const parsed = parseDnsCorrelationResult(completeResultBody(), parsePolicy());

    expect(parsed).toEqual({
      ecs: { observed: true, prefixLength: 24 },
      observedAt: NOW - 100,
      recursiveResolvers: [
        { address: '203.0.113.45', family: 'ipv4' },
        { address: '2001:db8:abcd:12::45', family: 'ipv6' },
      ],
      sourceTime: NOW - 200,
      state: 'correlated',
    });
    expect(parsed).not.toHaveProperty('headers');
    expect(parsed).not.toHaveProperty('queryLog');
    expect(parsed).not.toHaveProperty('packet');
  });

  it('validates address families, counts, times, and unknown raw fields', () => {
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({ resolvers: [{ address: 'not-an-ip', family: 'ipv4' }] }),
        parsePolicy(),
      ),
    ).toThrow();
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({
          resolvers: [{ address: '203.0.113.45', family: 'ipv6' }],
        }),
        parsePolicy(),
      ),
    ).toThrow();
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({
          resolvers: [{ address: '203.0.113.45', family: 4 }],
        }),
        parsePolicy(),
      ),
    ).toThrow();
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({
          resolvers: Array.from({ length: 5 }, (_, index) => ({
            address: `203.0.113.${index + 1}`,
            family: 'ipv4',
          })),
        }),
        parsePolicy(),
      ),
    ).toThrow();
    expect(() =>
      parseDnsCorrelationResult(completeResultBody({ observedAt: NOW + 1_001 }), parsePolicy()),
    ).toThrow();
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({ requestHeaders: { authorization: 'x' } }),
        parsePolicy(),
      ),
    ).toThrow();
  });

  it('rejects exact ECS subnets unless policy permits them and always strips the exact value', () => {
    const withSubnet = completeResultBody({
      ecs: { exactSubnet: '198.51.100.0/24', observed: true, prefixLength: 24 },
    });

    expect(() => parseDnsCorrelationResult(withSubnet, parsePolicy())).toThrow(
      'Exact ECS subnet is not permitted',
    );
    const parsed = parseDnsCorrelationResult(
      withSubnet,
      parsePolicy({ allowExactEcsSubnet: true }),
    );
    expect(parsed.ecs).toEqual({ observed: true, prefixLength: 24 });
    expect(JSON.stringify(parsed)).not.toContain('198.51.100.0');
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({
          ecs: { exactSubnet: '198.51.100.0/24', observed: true, prefixLength: 25 },
        }),
        parsePolicy({ allowExactEcsSubnet: true }),
      ),
    ).toThrow('prefix length mismatch');
    expect(() =>
      parseDnsCorrelationResult(
        completeResultBody({
          ecs: { exactSubnet: '198.51.100.7/24', observed: true, prefixLength: 24 },
        }),
        parsePolicy({ allowExactEcsSubnet: true }),
      ),
    ).toThrow('Invalid ECS subnet');
  });

  it('enforces the UTF-8 response byte limit before parsing JSON', () => {
    expect(() =>
      parseDnsCorrelationResult(JSON.stringify({ padding: '界'.repeat(100), state: 'pending' }), {
        ...parsePolicy(),
        maxResponseBytes: 128,
      }),
    ).toThrow('fixed limit');
  });
});

describe('DNS evidence persistence redaction', () => {
  it('masks every address, adds keyed HMAC fingerprints, and persists no exact address', async () => {
    const { request } = successfulRequester();
    const transient = await collectDnsCorrelationEvidence(
      basePorts({ requestApplicationSession: request }),
      { approvedService: policy(), hostname: 'api.example.test' },
    );
    Object.assign(transient.authoritativeCorrelation.ecs, {
      exactSubnet: '192.0.2.0/24',
    });
    const signer = vi.fn((_message: string) =>
      Uint8Array.from({ length: 32 }, (_, index) => index),
    );

    const persisted = redactDnsEvidenceForPersistence(transient, signer);
    const serialized = JSON.stringify(persisted);

    expect(serialized).not.toMatch(/"family":(?:4|6)(?:[,}])/);
    for (const exactAddress of [
      '10.20.30.53',
      '2001:db8:ffff:1::53',
      '198.51.100.44',
      '2001:db8:abcd:12::44',
      '203.0.113.45',
      '2001:db8:abcd:12::45',
      '192.0.2.0',
    ]) {
      expect(serialized).not.toContain(exactAddress);
    }
    expect(serialized).toContain('10.20.30.0/24');
    expect(serialized).toContain('198.51.100.0/24');
    expect(serialized).toContain('203.0.113.0/24');
    expect(serialized).toContain('2001:db8:ffff:1::/64');
    expect(serialized).toContain('2001:db8:abcd:12::/64');
    expect(serialized).toContain('hmac-sha256:');
    expect(signer).toHaveBeenCalledWith(expect.stringMatching(/^claudedock:dns-address:v1:/));
  });

  it('has no unsalted hash fallback when a keyed HMAC signer is absent or invalid', async () => {
    const transient = await collectDnsCorrelationEvidence(basePorts(), {
      hostname: 'api.example.test',
    });

    expect(() => redactDnsEvidenceForPersistence(transient, () => new Uint8Array(16))).toThrow(
      'keyed HMAC-SHA-256 signer is required',
    );
  });
});

describe('DNS collector dependency boundary', () => {
  it('contains no direct network, resolver, subprocess, or public-service fallback', () => {
    const source = readFileSync(
      new URL('../../src/main/egress-diagnostics/collectors/dns-correlation.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/from ['"]node:(?:dns|http|https|child_process)['"]/);
    expect(source).not.toMatch(/\b(?:fetch|lookup|resolve4|resolve6|exec|spawn)\s*\(/);
    expect(source).not.toMatch(/(?:curl|powershell|ping\.exe|ip-api|browserleaks|ipleak)/i);
  });
});
