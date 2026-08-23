import type {
  EgressAddressFamily,
  EgressCollectionState,
  EgressDiagnosticIssueCode,
  EgressEvidenceAssessment,
  EgressExplanation,
  EgressProviderId,
} from '../../shared/contracts/egress-diagnostics';

export interface EgressExplanationInput {
  readonly assessment: EgressEvidenceAssessment;
  readonly family: EgressAddressFamily;
  readonly issueCode?: EgressDiagnosticIssueCode;
  readonly provider: EgressProviderId;
  readonly state: EgressCollectionState;
}

const PROVIDER_LABELS: Readonly<Record<EgressProviderId, string>> = Object.freeze({
  abuseipdb: 'AbuseIPDB',
  'ipinfo-max': 'IPinfo Max',
  ipify: 'ipify',
  'maxmind-anonymous-plus': 'MaxMind Anonymous Plus',
});

const STATE_FACTS: Readonly<Record<EgressCollectionState, string>> = Object.freeze({
  cancelled: 'Collection was cancelled before this source completed.',
  collecting: 'Collection is still in progress.',
  complete: 'This source completed with strictly parsed evidence.',
  partial: 'Only part of the requested evidence completed.',
  unavailable: 'This source did not produce usable evidence.',
});

const AGREEMENT_FACTS: Readonly<Record<EgressEvidenceAssessment['agreement'], string>> =
  Object.freeze({
    corroborated: 'Comparable address observations agree.',
    mixed: 'Comparable address observations differ.',
    'not-comparable': 'No like-for-like address comparison was available.',
    'single-source': 'Only one comparable address observation was available.',
  });

const FRESHNESS_FACTS: Readonly<Record<EgressEvidenceAssessment['freshness'], string>> =
  Object.freeze({
    dated: 'The applicable source or lease marker is dated.',
    live: 'The evidence comes from the current live collection lease.',
    recent: 'The provider source timestamp is recent.',
    unknown: 'Source freshness could not be established.',
  });

const INVALID_CONFIGURATION_RECOMMENDATIONS: Readonly<Record<EgressProviderId, string>> =
  Object.freeze({
    abuseipdb: 'Review the main-process-owned AbuseIPDB lookback and request configuration.',
    'ipinfo-max': 'Review the main-process-owned IPinfo Max request configuration.',
    ipify: 'Review the main-process-owned ipify request configuration.',
    'maxmind-anonymous-plus':
      'Review the main-process-owned MaxMind database path and local file policy.',
  });

const recommendationForIssue = (input: EgressExplanationInput): string | undefined => {
  const provider = PROVIDER_LABELS[input.provider];
  if (input.issueCode === 'missing-credential') {
    return `Configure the optional ${provider} credential to add its evidence.`;
  }
  if (input.issueCode === 'rate-limited') {
    return `Retry ${provider} after its reported rate-limit window.`;
  }
  if (input.issueCode === 'invalid-configuration') {
    return INVALID_CONFIGURATION_RECOMMENDATIONS[input.provider];
  }
  if (input.issueCode === 'lookup-failed') {
    return input.provider === 'maxmind-anonymous-plus'
      ? 'Retry the local MaxMind lookup after verifying the approved database is readable.'
      : `Retry the ${provider} source collection.`;
  }
  if (input.issueCode === 'malformed-response') {
    return `Discard the malformed ${provider} data and collect fresh source evidence.`;
  }
  if (input.issueCode === 'family-mismatch') {
    return `Compare ${provider} only with the same address family as the live baseline.`;
  }
  if (input.issueCode === 'cancelled') {
    return 'Run a new collection if current evidence is still needed.';
  }
  return undefined;
};

export const createEgressExplanation = (input: EgressExplanationInput): EgressExplanation => {
  const providerLabel = PROVIDER_LABELS[input.provider];
  const familyLabel = input.family === 'ipv4' ? 'IPv4' : 'IPv6';
  const recommendations: string[] = [];
  const issueRecommendation = recommendationForIssue(input);
  if (issueRecommendation) recommendations.push(issueRecommendation);
  if (input.assessment.agreement === 'mixed') {
    recommendations.push(
      'Compare the live baseline with another same-family source before interpreting the difference.',
    );
  }
  if (input.assessment.freshness === 'dated' || input.assessment.freshness === 'unknown') {
    recommendations.push('Refresh the evidence before relying on time-sensitive provider facts.');
  }
  if (input.assessment.confidence === 'limited') {
    recommendations.push(
      'Treat these facts as limited context rather than a standalone conclusion.',
    );
  }
  if (input.state === 'unavailable' && input.family === 'ipv6') {
    recommendations.push('Assess IPv6 availability independently from the IPv4 result.');
  }
  return {
    facts: [
      `${providerLabel} supplied the ${familyLabel} source.`,
      STATE_FACTS[input.state],
      FRESHNESS_FACTS[input.assessment.freshness],
      AGREEMENT_FACTS[input.assessment.agreement],
    ],
    recommendations,
    summary: `${providerLabel} ${familyLabel} evidence is ${input.state}.`,
  };
};
