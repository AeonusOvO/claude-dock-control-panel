import { createHmac } from 'node:crypto';
import type {
  NetworkEnvironmentAssessment,
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
  readonly fresh: boolean;
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

export interface NetworkPreflightRouteIdentity {
  readonly action: NetworkPreflightAction;
  readonly canonicalCwd?: string;
  readonly configurationRevision: string;
  readonly generation: number;
  readonly networkScope: NetworkPreflightScope;
  readonly provider: NetworkProviderId;
  readonly target?: Readonly<NetworkPreflightTarget>;
}

export const networkPreflightRequiredScopes = (
  capture: NetworkPreflightRequestCapture,
): readonly NetworkPreflightScope[] =>
  Object.freeze(
    capture.target || capture.networkScope === 'application'
      ? [capture.networkScope]
      : ['application', 'conversation'],
  );

export const networkRouteRevision = (
  provider: NetworkProviderId,
  lease: {
    readonly scopes: readonly NetworkPreflightScope[];
    readonly epochs: Readonly<Partial<Record<NetworkPreflightScope, string>>>;
  },
  revisionKey: Uint8Array,
): string => {
  const epochs = lease.scopes.map((scope) => {
    const epoch = lease.epochs[scope];
    if (!epoch) throw new Error(`网络预检作用范围 ${scope} 缺少稳定配置标识。`);
    return [scope, epoch] as const;
  });
  return createHmac('sha256', revisionKey)
    .update(JSON.stringify([getProviderProfile(provider).profileVersion, epochs]))
    .digest('base64url');
};

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

export const networkPreflightUnavailableEnvironmentAssessment = (
  error: unknown,
): NetworkEnvironmentAssessment => {
  const checkedAt = Date.now();
  const detail = error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180);
  return {
    checkedAt,
    checks: [],
    dnsDetail: '环境辅助证据收集器未能完成。',
    dnsStatus: 'unknown',
    evidenceStatus: 'unavailable',
    issues: [
      {
        detail,
        kind: 'evidence-incomplete',
        severity: 'info',
        title: '辅助证据不可用',
      },
    ],
    localLanguage: 'unknown',
    localTimezone: 'unknown',
    publicAddressObservations: [],
    riskLevel: 'unknown',
    summary: '环境辅助证据不可用；这不代表提供商端点不可达。',
  };
};

export const networkPreflightInternalFailureResult = (
  provider: NetworkProviderId,
  identity: NetworkPreflightIdentity,
  startedAt: number,
  error: unknown,
): NetworkPreflightResult => {
  const checkedAt = Date.now();
  const profile = getProviderProfile(provider);
  const detail = error instanceof Error ? error.message : String(error);
  const providerConnectivity = {
    featureAccess: [
      {
        action: identity.action,
        allowed: false,
        reason: '提供商端点网络预检自身未能完成。',
      },
    ],
    probes: [],
    reasons: [detail],
    signals: [
      {
        confidence: 'high' as const,
        detail,
        id: 'preflight-internal-failure',
        label: '提供商端点网络预检未完成',
        observedAt: checkedAt,
        score: 100,
        severity: 'critical' as const,
        source: 'preflight-service',
      },
    ],
    status: 'blocked' as const,
    summary: `${profile.displayName} 的提供商端点网络预检未完成，相关动作已阻止。`,
  };
  const advisoryEvidence = {
    paths: [],
    reasons: [],
    riskLevel: 'unknown' as const,
    riskScore: 0,
    signals: [],
    summary: '本次未形成可用的辅助网络证据。',
  };
  return {
    ...identity,
    advisoryEvidence,
    checkedAt,
    featureAccess: providerConnectivity.featureAccess,
    paths: advisoryEvidence.paths,
    probes: providerConnectivity.probes,
    provider,
    providerConnectivity,
    providerLabel: profile.displayName,
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: providerConnectivity.signals,
    startedAt,
    status: providerConnectivity.status,
    summary: providerConnectivity.summary,
  };
};

export const networkPreflightTestingResult = (
  provider: NetworkProviderId,
  identity: NetworkPreflightIdentity,
  startedAt: number,
): NetworkPreflightResult => {
  const providerLabel = getProviderProfile(provider).displayName;
  const providerConnectivity = {
    featureAccess: [],
    probes: [],
    reasons: [],
    signals: [],
    status: 'testing' as const,
    summary: `${providerLabel} 正在执行无额度提供商端点网络预检。`,
  };
  const advisoryEvidence = {
    paths: [],
    reasons: [],
    riskLevel: 'unknown' as const,
    riskScore: 0,
    signals: [],
    summary: '显式代理、本机接口与目标限定的环境辅助证据正在收集。',
  };
  return {
    ...identity,
    advisoryEvidence,
    featureAccess: providerConnectivity.featureAccess,
    paths: advisoryEvidence.paths,
    probes: providerConnectivity.probes,
    provider,
    providerConnectivity,
    providerLabel,
    reasons: providerConnectivity.reasons,
    riskLevel: advisoryEvidence.riskLevel,
    riskScore: advisoryEvidence.riskScore,
    schemaVersion: 2,
    signals: [],
    startedAt,
    status: 'testing',
    summary: providerConnectivity.summary,
  };
};
