import type {
  EgressDiagnosticIssue,
  EgressLiveSourceEvidence,
  EgressRateLimitMetadata,
  EgressSourceTime,
  LiveExactEgressAddress,
} from '../../../shared/contracts/egress-diagnostics';
import { EgressAddressError, normalizeEgressAddress } from '../address';
import {
  EgressApplicationRequestError,
  type EgressApplicationRequest,
} from '../application-request';
import { deriveEvidenceAssessment } from '../evidence-policy';
import { createEgressExplanation } from '../explanation';
import {
  EgressParseError,
  isoTimestampEpoch,
  optionalBoolean,
  optionalString,
  parseJsonObject,
  requiredBoolean,
  requiredInteger,
  requiredObject,
  requiredString,
} from '../parsing';

export interface AbuseIpDbFacts {
  readonly abuseConfidenceScore: number;
  readonly countryCode?: string;
  readonly domain?: string;
  readonly isPublic: boolean;
  readonly isTor: boolean;
  readonly isWhitelisted?: boolean;
  readonly isp?: string;
  readonly lastReportedAt?: string;
  readonly numDistinctUsers: number;
  readonly totalReports: number;
  readonly usageType?: string;
}

export interface AbuseIpDbEvidence extends EgressLiveSourceEvidence {
  readonly facts?: AbuseIpDbFacts;
  readonly provider: 'abuseipdb';
  readonly rateLimit: EgressRateLimitMetadata;
}

export interface AbuseIpDbAdapterOptions {
  readonly key: () => string | undefined;
  readonly maxAgeInDays?: number;
  readonly now?: () => number;
  readonly request: EgressApplicationRequest;
}

export interface AbuseIpDbCollectInput {
  readonly baseline: LiveExactEgressAddress;
  readonly leaseCurrent: boolean;
  readonly signal?: AbortSignal;
}

export interface ParsedAbuseIpDb {
  readonly address: LiveExactEgressAddress;
  readonly facts: AbuseIpDbFacts;
  readonly sourceTimes: readonly EgressSourceTime[];
}

export const parseAbuseIpDbPayload = (
  bytes: Uint8Array,
  family: LiveExactEgressAddress['family'],
): ParsedAbuseIpDb => {
  const root = parseJsonObject(bytes);
  const data = requiredObject(root, 'data');
  const address = normalizeEgressAddress(requiredString(data, 'ipAddress', 64), family);
  const ipVersion = requiredInteger(data, 'ipVersion', 4, 6);
  if ((family === 'ipv4' && ipVersion !== 4) || (family === 'ipv6' && ipVersion !== 6)) {
    throw new EgressAddressError('family-mismatch');
  }
  const lastReportedAt = optionalString(data, 'lastReportedAt', 40);
  const lastReportedEpoch = lastReportedAt ? isoTimestampEpoch(lastReportedAt) : undefined;
  if (lastReportedAt && lastReportedEpoch === undefined) throw new EgressParseError();
  return {
    address,
    facts: {
      abuseConfidenceScore: requiredInteger(data, 'abuseConfidenceScore', 0, 100),
      countryCode: optionalString(data, 'countryCode', 8),
      domain: optionalString(data, 'domain', 253),
      isPublic: requiredBoolean(data, 'isPublic'),
      isTor: requiredBoolean(data, 'isTor'),
      isWhitelisted: optionalBoolean(data, 'isWhitelisted'),
      isp: optionalString(data, 'isp', 240),
      lastReportedAt,
      numDistinctUsers: requiredInteger(data, 'numDistinctUsers', 0, Number.MAX_SAFE_INTEGER),
      totalReports: requiredInteger(data, 'totalReports', 0, Number.MAX_SAFE_INTEGER),
      usageType: optionalString(data, 'usageType', 160),
    },
    sourceTimes:
      lastReportedAt && lastReportedEpoch !== undefined
        ? [{ epochMs: lastReportedEpoch, label: 'lastReportedAt', value: lastReportedAt }]
        : [],
  };
};

const retryAt = (error: EgressApplicationRequestError, collectedAt: number): number | undefined =>
  error.rateLimit.resetAt ??
  (error.rateLimit.retryAfterSeconds === undefined
    ? undefined
    : collectedAt + error.rateLimit.retryAfterSeconds * 1_000);

const safeIssue = (
  error: unknown,
  collectedAt: number,
): { issue: EgressDiagnosticIssue; rateLimit: EgressRateLimitMetadata } => {
  if (error instanceof EgressApplicationRequestError) {
    return {
      issue: { code: error.code, message: error.message, retryAt: retryAt(error, collectedAt) },
      rateLimit: error.rateLimit,
    };
  }
  if (error instanceof EgressAddressError) {
    return { issue: { code: error.code, message: error.message }, rateLimit: {} };
  }
  if (error instanceof EgressParseError) {
    return { issue: { code: 'malformed-response', message: error.message }, rateLimit: {} };
  }
  return {
    issue: { code: 'transport-failed', message: 'AbuseIPDB evidence collection failed.' },
    rateLimit: {},
  };
};

const unavailableEvidence = (
  baseline: LiveExactEgressAddress,
  collectedAt: number,
  leaseCurrent: boolean,
  issue: EgressDiagnosticIssue,
  rateLimit: EgressRateLimitMetadata = {},
): AbuseIpDbEvidence => {
  const state = issue.code === 'cancelled' ? 'cancelled' : 'unavailable';
  const assessment = deriveEvidenceAssessment({
    collectionState: state,
    leaseCurrent,
    sourceFreshness: 'unknown',
    strictParse: false,
    transport: 'electron-net:application-session',
  });
  return {
    assessment,
    explanation: createEgressExplanation({
      assessment,
      family: baseline.family,
      issueCode: issue.code,
      provider: 'abuseipdb',
      state,
    }),
    family: baseline.family,
    issue,
    kind: 'live-source',
    provider: 'abuseipdb',
    provenance: {
      collectedAt,
      endpointId: 'abuseipdb-check',
      provider: 'abuseipdb',
      sourceTimes: [],
      transport: 'electron-net:application-session',
    },
    rateLimit,
    state,
  };
};

export const createAbuseIpDbAdapter = ({
  key,
  maxAgeInDays = 30,
  now = Date.now,
  request,
}: AbuseIpDbAdapterOptions): {
  collect: (input: AbuseIpDbCollectInput) => Promise<AbuseIpDbEvidence>;
} => ({
  collect: async (input) => {
    const collectedAt = now();
    const baseline = normalizeEgressAddress(input.baseline.address, input.baseline.family);
    if (!Number.isInteger(maxAgeInDays) || maxAgeInDays < 1 || maxAgeInDays > 365) {
      return unavailableEvidence(baseline, collectedAt, input.leaseCurrent, {
        code: 'invalid-configuration',
        message: 'The main-owned AbuseIPDB lookback is outside the documented range.',
      });
    }
    let credential: string | undefined;
    try {
      credential = key();
    } catch {
      credential = undefined;
    }
    if (!credential) {
      return unavailableEvidence(baseline, collectedAt, input.leaseCurrent, {
        code: 'missing-credential',
        message: 'The optional AbuseIPDB credential is not configured.',
      });
    }
    try {
      const response = await request({
        address: baseline.address,
        credential,
        endpointId: 'abuseipdb-check',
        maxAgeInDays,
        signal: input.signal,
      });
      const parsed = parseAbuseIpDbPayload(response.body, baseline.family);
      const assessment = deriveEvidenceAssessment({
        collectionState: 'complete',
        comparisonKeys: [baseline.address, parsed.address.address],
        leaseCurrent: input.leaseCurrent,
        sourceFreshness: 'live',
        strictParse: true,
        transport: 'electron-net:application-session',
      });
      return {
        address: parsed.address,
        assessment,
        explanation: createEgressExplanation({
          assessment,
          family: baseline.family,
          provider: 'abuseipdb',
          state: 'complete',
        }),
        facts: parsed.facts,
        family: baseline.family,
        kind: 'live-source',
        provider: 'abuseipdb',
        provenance: {
          collectedAt,
          endpointId: 'abuseipdb-check',
          provider: 'abuseipdb',
          sourceTimes: parsed.sourceTimes,
          transport: 'electron-net:application-session',
        },
        rateLimit: response.rateLimit,
        state: 'complete',
      };
    } catch (error) {
      const failed = safeIssue(error, collectedAt);
      return unavailableEvidence(
        baseline,
        collectedAt,
        input.leaseCurrent,
        failed.issue,
        failed.rateLimit,
      );
    }
  },
});
