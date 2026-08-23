import type {
  NetworkPreflightAction,
  NetworkPreflightResult,
  NetworkPreflightScope,
  NetworkProviderId,
} from '../../shared/contracts';
import { getProviderProfile } from '../../shared/router/provider-profiles';
import { networkPreflightTargetKey, type NetworkPreflightTarget } from './preflight-target';

export interface NetworkPreflightRequestCapture {
  readonly action: NetworkPreflightAction;
  readonly canonicalCwd?: string;
  readonly force: boolean;
  readonly networkScope: NetworkPreflightScope;
  readonly provider: NetworkProviderId;
  readonly target?: Readonly<NetworkPreflightTarget>;
}

export interface NetworkPreflightIdentity {
  action: NetworkPreflightAction;
  canonicalCwd?: string;
  configurationRevision: string;
  generation: number;
  mainRunId: number;
  networkScope: NetworkPreflightScope;
}

export const networkPreflightCwdCacheKey = (canonicalCwd: string | undefined): string =>
  canonicalCwd && process.platform === 'win32' ? canonicalCwd.toLowerCase() : (canonicalCwd ?? '');

export const networkPreflightCacheKey = (
  capture: NetworkPreflightRequestCapture,
  identity: Pick<
    NetworkPreflightIdentity,
    'canonicalCwd' | 'configurationRevision' | 'networkScope'
  >,
): string =>
  JSON.stringify([
    capture.provider,
    capture.action,
    identity.networkScope,
    networkPreflightCwdCacheKey(identity.canonicalCwd),
    identity.configurationRevision,
    networkPreflightTargetKey(capture.target),
  ]);

export const networkPreflightTestingResult = (
  provider: NetworkProviderId,
  identity: NetworkPreflightIdentity,
  startedAt: number,
): NetworkPreflightResult => ({
  ...identity,
  featureAccess: [],
  paths: [],
  probes: [],
  provider,
  providerLabel: getProviderProfile(provider).displayName,
  reasons: [],
  riskLevel: 'unknown',
  riskScore: 0,
  signals: [],
  startedAt,
  status: 'testing',
  summary: `${getProviderProfile(provider).displayName} 正在执行无额度网络预检。`,
});
