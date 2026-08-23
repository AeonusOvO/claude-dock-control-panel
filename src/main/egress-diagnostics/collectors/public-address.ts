import type {
  EgressAddressFamily,
  EgressDiagnosticIssue,
  EgressLiveReport,
  EgressLiveSourceEvidence,
  LiveExactEgressAddress,
} from '../../../shared/contracts/egress-diagnostics';
import { EgressAddressError, normalizeEgressAddress } from '../address';
import {
  EgressApplicationRequestError,
  type EgressApplicationRequest,
} from '../application-request';
import { deriveEvidenceAssessment } from '../evidence-policy';
import { createEgressExplanation } from '../explanation';
import { EgressParseError, parseJsonObject, requiredString } from '../parsing';

export interface PublicAddressCollectorOptions {
  readonly now?: () => number;
  readonly request: EgressApplicationRequest;
}

export interface PublicAddressCollectionInput {
  readonly leaseCurrent: boolean;
  readonly signal?: AbortSignal;
}

export interface PublicAddressEvidence extends EgressLiveSourceEvidence {
  readonly provider: 'ipify';
}

export interface PublicAddressCollection extends Omit<EgressLiveReport, 'sources'> {
  readonly sources: readonly [PublicAddressEvidence, PublicAddressEvidence];
}

const endpointForFamily = (
  family: EgressAddressFamily,
): 'public-address-v4' | 'public-address-v6' =>
  family === 'ipv4' ? 'public-address-v4' : 'public-address-v6';

export const parsePublicAddressPayload = (
  bytes: Uint8Array,
  family: EgressAddressFamily,
): LiveExactEgressAddress => {
  const object = parseJsonObject(bytes);
  const keys = Object.keys(object);
  if (keys.length !== 1 || keys[0] !== 'ip') {
    throw new EgressParseError('The public-address response must contain exactly the ip field.');
  }
  return normalizeEgressAddress(requiredString(object, 'ip', 64), family);
};

const safeIssue = (error: unknown): EgressDiagnosticIssue => {
  if (error instanceof EgressApplicationRequestError) {
    return { code: error.code, message: error.message, retryAt: error.rateLimit.resetAt };
  }
  if (error instanceof EgressAddressError) return { code: error.code, message: error.message };
  if (error instanceof EgressParseError)
    return { code: 'malformed-response', message: error.message };
  return { code: 'transport-failed', message: 'The public-address source failed.' };
};

const stateForIssue = (issue: EgressDiagnosticIssue): 'cancelled' | 'unavailable' =>
  issue.code === 'cancelled' ? 'cancelled' : 'unavailable';

const collectFamily = async (
  request: EgressApplicationRequest,
  family: EgressAddressFamily,
  input: PublicAddressCollectionInput,
  collectedAt: number,
): Promise<PublicAddressEvidence> => {
  const endpointId = endpointForFamily(family);
  try {
    const response = await request({ endpointId, signal: input.signal });
    const address = parsePublicAddressPayload(response.body, family);
    const assessment = deriveEvidenceAssessment({
      collectionState: 'complete',
      comparisonKeys: [address.address],
      leaseCurrent: input.leaseCurrent,
      sourceFreshness: 'live',
      strictParse: true,
      transport: 'electron-net:application-session',
    });
    return {
      address,
      assessment,
      explanation: createEgressExplanation({
        assessment,
        family,
        provider: 'ipify',
        state: 'complete',
      }),
      family,
      kind: 'live-source',
      provider: 'ipify',
      provenance: {
        collectedAt,
        endpointId,
        provider: 'ipify',
        sourceTimes: [
          {
            epochMs: collectedAt,
            label: 'http-response',
            value: new Date(collectedAt).toISOString(),
          },
        ],
        transport: 'electron-net:application-session',
      },
      state: 'complete',
    };
  } catch (error) {
    const issue = safeIssue(error);
    const state = stateForIssue(issue);
    const assessment = deriveEvidenceAssessment({
      collectionState: state,
      leaseCurrent: input.leaseCurrent,
      sourceFreshness: 'unknown',
      strictParse: false,
      transport: 'electron-net:application-session',
    });
    return {
      assessment,
      explanation: createEgressExplanation({
        assessment,
        family,
        issueCode: issue.code,
        provider: 'ipify',
        state,
      }),
      family,
      issue,
      kind: 'live-source',
      provider: 'ipify',
      provenance: {
        collectedAt,
        endpointId,
        provider: 'ipify',
        sourceTimes: [],
        transport: 'electron-net:application-session',
      },
      state,
    };
  }
};

const collectionState = (
  sources: readonly [PublicAddressEvidence, PublicAddressEvidence],
): PublicAddressCollection['state'] => {
  const complete = sources.filter((source) => source.state === 'complete').length;
  if (complete === sources.length) return 'complete';
  if (complete > 0) return 'partial';
  if (sources.every((source) => source.state === 'cancelled')) return 'cancelled';
  return 'unavailable';
};

export const createPublicAddressCollector = ({
  now = Date.now,
  request,
}: PublicAddressCollectorOptions): {
  collect: (input: PublicAddressCollectionInput) => Promise<PublicAddressCollection>;
} => ({
  collect: async (input) => {
    const collectedAt = now();
    const sources = await Promise.all([
      collectFamily(request, 'ipv4', input, collectedAt),
      collectFamily(request, 'ipv6', input, collectedAt),
    ]);
    const state = collectionState(sources);
    const assessment = deriveEvidenceAssessment({
      collectionState: state,
      leaseCurrent: input.leaseCurrent,
      sourceFreshness: sources.some((source) => source.state === 'complete') ? 'live' : 'unknown',
      strictParse: sources.every((source) => source.state === 'complete'),
      transport: 'electron-net:application-session',
    });
    return {
      assessment,
      collectedAt,
      explanation: {
        facts: [
          `IPv4 collection is ${sources[0].state}.`,
          `IPv6 collection is ${sources[1].state}.`,
          'IPv4 and IPv6 availability are assessed independently.',
        ],
        recommendations:
          state === 'partial'
            ? ['Interpret the unavailable address family independently from the completed family.']
            : [],
        summary: `Public-address collection is ${state}.`,
      },
      kind: 'live-report',
      sources,
      state,
    };
  },
});
