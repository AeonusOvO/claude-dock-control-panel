import type {
  EgressAgreement,
  EgressCollectionState,
  EgressConfidence,
  EgressEvidenceAssessment,
  EgressFreshness,
  EgressTransportId,
} from '../../shared/contracts/egress-diagnostics';

const RECENT_SOURCE_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1_000;

export interface EvidencePolicyInput {
  readonly collectionState: EgressCollectionState;
  readonly comparisonKeys?: readonly string[];
  readonly leaseCurrent: boolean;
  readonly sourceFreshness: EgressFreshness;
  readonly strictParse: boolean;
  readonly transport: EgressTransportId;
}

export interface SourceFreshnessInput {
  readonly liveObservation?: boolean;
  readonly now: number;
  readonly sourceTimestamps: readonly number[];
}

export const deriveSourceFreshness = ({
  liveObservation = false,
  now,
  sourceTimestamps,
}: SourceFreshnessInput): EgressFreshness => {
  if (liveObservation) return 'live';
  const usable = sourceTimestamps.filter(
    (value) => Number.isFinite(value) && value >= 0 && value <= now + FUTURE_CLOCK_TOLERANCE_MS,
  );
  if (usable.length === 0) return 'unknown';
  const newest = Math.max(...usable);
  return now - newest <= RECENT_SOURCE_WINDOW_MS ? 'recent' : 'dated';
};

const deriveAgreement = (comparisonKeys?: readonly string[]): EgressAgreement => {
  if (!comparisonKeys || comparisonKeys.length === 0) return 'not-comparable';
  if (comparisonKeys.length === 1) return 'single-source';
  const first = comparisonKeys[0];
  return comparisonKeys.every((key) => key === first) ? 'corroborated' : 'mixed';
};

const effectiveFreshness = (
  state: EgressCollectionState,
  leaseCurrent: boolean,
  sourceFreshness: EgressFreshness,
): EgressFreshness => {
  if (state === 'collecting' || state === 'unavailable' || state === 'cancelled') {
    return 'unknown';
  }
  if (!leaseCurrent) return sourceFreshness === 'unknown' ? 'unknown' : 'dated';
  return sourceFreshness;
};

const deriveConfidence = (
  input: EvidencePolicyInput,
  agreement: EgressAgreement,
  freshness: EgressFreshness,
): EgressConfidence => {
  if (
    input.collectionState === 'collecting' ||
    input.collectionState === 'unavailable' ||
    input.collectionState === 'cancelled'
  ) {
    return 'unknown';
  }
  const supportedTransport =
    input.transport === 'electron-net:application-session' ||
    input.transport === 'local:maxmind-mmdb';
  if (!supportedTransport || !input.strictParse || !input.leaseCurrent) return 'limited';
  if (freshness === 'unknown' || freshness === 'dated' || agreement === 'mixed') return 'limited';
  if (input.collectionState === 'complete' && agreement === 'corroborated') return 'high';
  if (input.collectionState === 'complete') return 'moderate';
  return agreement === 'corroborated' ? 'moderate' : 'limited';
};

export const deriveEvidenceAssessment = (input: EvidencePolicyInput): EgressEvidenceAssessment => {
  const agreement = deriveAgreement(input.comparisonKeys);
  const freshness = effectiveFreshness(
    input.collectionState,
    input.leaseCurrent,
    input.sourceFreshness,
  );
  return {
    agreement,
    confidence: deriveConfidence(input, agreement, freshness),
    freshness,
  };
};
