import type {
  NetworkPreflightHistoryView,
  NetworkPreflightResult,
  NetworkPreflightRunInput,
  NetworkPreflightSettings,
  NetworkProviderId,
} from '../shared/contracts';
import { getProviderProfile } from '../shared/provider-profiles';
import { NetworkDiagnosticsStore } from './network-diagnostics-store';
import { NetworkPreflightSettingsStore } from './network-preflight-settings-store';
import { ProviderConnectivityProbe } from './provider-connectivity-probe';
import { RiskDecisionEngine } from './risk-decision-engine';

interface CachedResult {
  result: NetworkPreflightResult;
}

interface NetworkPreflightServiceOptions {
  diagnosticsStore: NetworkDiagnosticsStore;
  onResult?: (result: NetworkPreflightResult) => void;
  probe: Pick<ProviderConnectivityProbe, 'run'>;
  riskEngine?: RiskDecisionEngine;
  settingsStore: NetworkPreflightSettingsStore;
}

const cacheKey = (input: NetworkPreflightRunInput): string =>
  `${input.provider}:${input.action}:${input.cwd ?? ''}`;

const testingResult = (
  input: NetworkPreflightRunInput,
  startedAt: number,
): NetworkPreflightResult => ({
  featureAccess: [],
  paths: [],
  probes: [],
  provider: input.provider,
  providerLabel: getProviderProfile(input.provider).displayName,
  reasons: [],
  riskLevel: 'unknown',
  riskScore: 0,
  signals: [],
  startedAt,
  status: 'testing',
  summary: `${getProviderProfile(input.provider).displayName} 正在执行无额度网络预检。`,
});

export class NetworkPreflightService {
  private readonly cache = new Map<string, CachedResult>();
  private generation = 0;
  private readonly inFlight = new Map<string, Promise<NetworkPreflightResult>>();
  private readonly lastEgress = new Map<NetworkProviderId, NetworkPreflightResult['egress']>();
  private readonly riskEngine: RiskDecisionEngine;

  public constructor(private readonly options: NetworkPreflightServiceOptions) {
    this.riskEngine = options.riskEngine ?? new RiskDecisionEngine();
  }

  public get(provider: NetworkProviderId): Promise<NetworkPreflightResult> {
    return this.run({ action: 'background', provider });
  }

  public run(input: NetworkPreflightRunInput): Promise<NetworkPreflightResult> {
    const key = cacheKey(input);
    const cached = this.cache.get(key)?.result;
    const now = Date.now();
    if (!input.force && cached?.cacheExpiresAt && cached.cacheExpiresAt > now) {
      return Promise.resolve(cached);
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const generationAtStart = this.generation;
    const startedAt = now;
    this.options.onResult?.(testingResult(input, startedAt));
    const operation = this.options.probe
      .run(
        input.provider,
        input.action,
        this.options.settingsStore.get().enhancedPrivacyMode,
        input.cwd,
      )
      .then((observation) => {
        const checkedAt = Date.now();
        const result = this.riskEngine.evaluate(
          input.provider,
          input.action,
          observation,
          startedAt,
          checkedAt,
          this.lastEgress.get(input.provider),
        );
        if (generationAtStart === this.generation) {
          this.cache.set(key, { result });
          this.lastEgress.set(input.provider, result.egress);
          this.options.diagnosticsStore.append(result);
          this.options.onResult?.(result);
        }
        return result;
      })
      .catch((error: unknown) => {
        const checkedAt = Date.now();
        const profile = getProviderProfile(input.provider);
        const detail = error instanceof Error ? error.message : String(error);
        const result: NetworkPreflightResult = {
          checkedAt,
          featureAccess: [
            {
              action: input.action,
              allowed: false,
              reason: '网络预检自身未能完成。',
            },
          ],
          paths: [],
          probes: [],
          provider: input.provider,
          providerLabel: profile.displayName,
          reasons: [detail],
          riskLevel: 'unknown',
          riskScore: 100,
          signals: [
            {
              confidence: 'high',
              detail,
              id: 'preflight-internal-failure',
              label: '网络预检未完成',
              observedAt: checkedAt,
              score: 100,
              severity: 'critical',
              source: 'preflight-service',
            },
          ],
          startedAt,
          status: 'blocked',
          summary: `${profile.displayName} 网络预检未完成，高风险动作已阻止。`,
        };
        if (generationAtStart === this.generation) {
          this.options.diagnosticsStore.append(result);
          this.options.onResult?.(result);
        }
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(key) === operation) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  public invalidate(_reason: string): void {
    this.generation += 1;
    this.cache.clear();
  }

  public getSettings(): NetworkPreflightSettings {
    return this.options.settingsStore.get();
  }

  public setSettings(settings: NetworkPreflightSettings): NetworkPreflightSettings {
    const saved = this.options.settingsStore.set(settings);
    this.invalidate('settings-changed');
    return saved;
  }

  public getHistory(): NetworkPreflightHistoryView {
    return this.options.diagnosticsStore.getView();
  }

  public clearHistory(): NetworkPreflightHistoryView {
    this.lastEgress.clear();
    return this.options.diagnosticsStore.clear();
  }
}
