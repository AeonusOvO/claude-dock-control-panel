import type {
  NetworkPreflightAction,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../../shared/contracts';

export interface PreflightOperationToken {
  readonly action: NetworkPreflightAction;
  readonly manual: boolean;
  readonly provider: NetworkProviderId;
  readonly sequence: number;
}

export interface PreflightState {
  networkPreflightDialogProvider?: NetworkProviderId;
  networkPreflightDisplayProvider?: NetworkProviderId;
  networkPreflightOperation?: PreflightOperationToken;
  networkPreflightResults: Map<NetworkProviderId, NetworkPreflightResult>;
}

export const createPreflightState = (): PreflightState => ({
  networkPreflightResults: new Map(),
});

export const ownsPreflightOperation = (
  state: PreflightState,
  operation: PreflightOperationToken,
): boolean => state.networkPreflightOperation === operation;

const isBackgroundApplicationResult = (result: NetworkPreflightResult): boolean =>
  result.action === 'background' &&
  result.networkScope === 'application' &&
  result.canonicalCwd === undefined;

export const clearTestingBackgroundResults = (state: PreflightState): boolean => {
  let changed = false;
  for (const [provider, result] of state.networkPreflightResults) {
    if (result.providerConnectivity.status === 'testing') {
      state.networkPreflightResults.delete(provider);
      changed = true;
    }
  }
  return changed;
};

export const acceptBackgroundApplicationResult = (
  state: PreflightState,
  result: NetworkPreflightResult,
): boolean => {
  if (!isBackgroundApplicationResult(result)) return false;
  const current = state.networkPreflightResults.get(result.provider);
  if (current) {
    if (result.generation < current.generation) return false;
    if (result.generation === current.generation) {
      if (result.mainRunId < current.mainRunId) return false;
      if (result.mainRunId === current.mainRunId) {
        if (current.providerConnectivity.status !== 'testing') return false;
        if (result.providerConnectivity.status === 'testing') return false;
      }
    }
  }
  state.networkPreflightResults.set(result.provider, result);
  return true;
};
