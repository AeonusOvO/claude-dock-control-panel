import type { NetworkPreflightResult } from '../../shared/contracts';

export const cachedNetworkPreflightEvidence = (
  result: NetworkPreflightResult,
): NetworkPreflightResult => {
  const environment = result.advisoryEvidence.environment;
  if (!environment) return result;
  const cachedEnvironment = {
    ...environment,
    checks: environment.checks?.map((check) => ({ ...check, freshness: 'cached' as const })),
    publicAddressObservations: environment.publicAddressObservations.map((observation) => ({
      ...observation,
      freshness: 'cached' as const,
    })),
  };
  return {
    ...result,
    advisoryEvidence: { ...result.advisoryEvidence, environment: cachedEnvironment },
    ...(result.environment ? { environment: cachedEnvironment } : {}),
  };
};
