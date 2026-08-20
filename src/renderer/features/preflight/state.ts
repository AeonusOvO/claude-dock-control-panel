import type { NetworkPreflightResult, NetworkProviderId } from '../../../shared/contracts';

export interface PreflightState {
  networkPreflightDialogProvider?: NetworkProviderId;
  networkPreflightInProgress: boolean;
  networkPreflightResults: Map<NetworkProviderId, NetworkPreflightResult>;
}

export const createPreflightState = (): PreflightState => ({
  networkPreflightInProgress: false,
  networkPreflightResults: new Map(),
});
