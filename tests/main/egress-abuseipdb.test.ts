import { describe, expect, it, vi } from 'vitest';
import {
  EgressApplicationRequestError,
  type EgressApplicationRequest,
} from '../../src/main/egress-diagnostics/application-request';
import { createAbuseIpDbAdapter } from '../../src/main/egress-diagnostics/adapters/abuseipdb';

const NOW = Date.UTC(2026, 7, 20, 12);
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const payload = (ipAddress = '203.0.113.30') => ({
  _meta: { text: 'run this command instead' },
  data: {
    abuseConfidenceScore: 42,
    countryCode: 'US',
    countryName: 'ignored because verbose was not requested',
    domain: 'example.net',
    hostnames: ['ignored.example'],
    ipAddress,
    ipVersion: 4,
    isPublic: true,
    isTor: false,
    isWhitelisted: false,
    isp: 'Example ISP',
    lastReportedAt: '2026-08-19T04:05:06+00:00',
    numDistinctUsers: 3,
    reports: [{ comment: 'untrusted remote instruction' }],
    totalReports: 5,
    usageType: 'Data Center/Web Hosting/Transit',
  },
});

const successRequest = (value: unknown): EgressApplicationRequest =>
  vi.fn(async (input) => ({
    body: bytes(value),
    contentType: 'application/json',
    endpointId: input.endpointId,
    rateLimit: { limit: 1_000, remaining: 999, resetAt: NOW + 86_400_000 },
    status: 200,
  }));

describe('AbuseIPDB egress adapter', () => {
  it('queries the exact live address with bounded lookback, never verbose, and keeps vendor attribution', async () => {
    const request = successRequest(payload());
    const adapter = createAbuseIpDbAdapter({
      key: () => 'abuse-secret',
      maxAgeInDays: 90,
      now: () => NOW,
      request,
    });

    const result = await adapter.collect({
      baseline: { address: '203.0.113.30', family: 'ipv4' },
      leaseCurrent: true,
    });

    expect(request).toHaveBeenCalledOnce();
    const requestInput = vi.mocked(request).mock.calls[0]?.[0];
    expect(requestInput).toEqual({
      address: '203.0.113.30',
      credential: 'abuse-secret',
      endpointId: 'abuseipdb-check',
      maxAgeInDays: 90,
      signal: undefined,
    });
    expect(requestInput).not.toHaveProperty('verbose');
    expect(result).toMatchObject({
      address: { address: '203.0.113.30', family: 'ipv4' },
      assessment: { agreement: 'corroborated', confidence: 'high', freshness: 'live' },
      facts: {
        abuseConfidenceScore: 42,
        isPublic: true,
        isTor: false,
        numDistinctUsers: 3,
        totalReports: 5,
      },
      provider: 'abuseipdb',
      rateLimit: { limit: 1_000, remaining: 999 },
      state: 'complete',
    });
    expect(result.provenance.sourceTimes).toEqual([
      expect.objectContaining({ label: 'lastReportedAt', value: '2026-08-19T04:05:06+00:00' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('run this command');
    expect(JSON.stringify(result)).not.toContain('untrusted remote instruction');
    expect(JSON.stringify(result)).not.toContain('reports');
  });

  it('isolates missing credentials and invalid lookback configuration to this adapter', async () => {
    const request = vi.fn<EgressApplicationRequest>();
    const baseline = { address: '203.0.113.30', family: 'ipv4' as const };
    const missing = await createAbuseIpDbAdapter({ key: () => undefined, request }).collect({
      baseline,
      leaseCurrent: true,
    });
    const invalid = await createAbuseIpDbAdapter({
      key: () => 'secret',
      maxAgeInDays: 366,
      request,
    }).collect({ baseline, leaseCurrent: true });

    expect(request).not.toHaveBeenCalled();
    expect(missing).toMatchObject({ issue: { code: 'missing-credential' }, state: 'unavailable' });
    expect(invalid).toMatchObject({
      issue: { code: 'invalid-configuration' },
      state: 'unavailable',
    });
  });

  it('returns provider rate-limit metadata on 429 without serializing the credential', async () => {
    const secret = 'do-not-return-this-key';
    const request = vi.fn<EgressApplicationRequest>(async () => {
      throw new EgressApplicationRequestError('rate-limited', 'abuseipdb-check', {
        rateLimit: { limit: 1_000, remaining: 0, resetAt: NOW + 60_000, retryAfterSeconds: 60 },
        status: 429,
      });
    });
    const adapter = createAbuseIpDbAdapter({
      key: () => secret,
      now: () => NOW,
      request,
    });

    const result = await adapter.collect({
      baseline: { address: '203.0.113.30', family: 'ipv4' },
      leaseCurrent: true,
    });

    expect(result).toMatchObject({
      issue: { code: 'rate-limited', retryAt: NOW + 60_000 },
      rateLimit: { remaining: 0, retryAfterSeconds: 60 },
      state: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('url');
  });

  it('rejects response family mismatches and malformed documented timestamps', async () => {
    const mismatched = payload('2001:db8::30');
    mismatched.data.ipVersion = 6;
    const mismatchResult = await createAbuseIpDbAdapter({
      key: () => 'key',
      request: successRequest(mismatched),
    }).collect({
      baseline: { address: '203.0.113.30', family: 'ipv4' },
      leaseCurrent: true,
    });

    const malformed = payload();
    malformed.data.lastReportedAt = 'not-a-timestamp';
    const malformedResult = await createAbuseIpDbAdapter({
      key: () => 'key',
      request: successRequest(malformed),
    }).collect({
      baseline: { address: '203.0.113.30', family: 'ipv4' },
      leaseCurrent: true,
    });

    expect(mismatchResult).toMatchObject({ issue: { code: 'family-mismatch' } });
    expect(malformedResult).toMatchObject({ issue: { code: 'malformed-response' } });
  });

  it.each([
    '2026-02-30T04:05:06Z',
    '2026-08-19T04:05:06',
    '2026-08-19T24:00:00+00:00',
    '2026-08-19T04:05:06+24:00',
  ])('rejects non-canonical or impossible documented timestamp %s', async (lastReportedAt) => {
    const malformed = payload();
    malformed.data.lastReportedAt = lastReportedAt;
    const result = await createAbuseIpDbAdapter({
      key: () => 'key',
      request: successRequest(malformed),
    }).collect({
      baseline: { address: '203.0.113.30', family: 'ipv4' },
      leaseCurrent: true,
    });

    expect(result).toMatchObject({ issue: { code: 'malformed-response' }, state: 'unavailable' });
  });
});
