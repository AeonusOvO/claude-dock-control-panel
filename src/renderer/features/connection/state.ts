import type {
  ClaudeConnectionAdvice,
  ClaudeGatewayDiagnostics,
  SaveClaudeConfigInput,
} from '../../../shared/contracts';
import type { ClaudeCurlAnalysis } from '../../../shared/claude/curl';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { ConfigurableEndpointProtocol } from '../../../shared/router/connection-endpoint';

export type AdvancedDraftControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface AdvancedDraftControlState {
  checked?: boolean;
  control: AdvancedDraftControl;
  value: string;
}

export interface AdvancedConnectionSnapshot {
  authMode: SaveClaudeConfigInput['authMode'];
  baseUrl: string;
  controls: AdvancedDraftControlState[];
  credential: string;
  model: string;
  modelFast: string;
  protocol: ConfigurableEndpointProtocol;
  providerId?: ClaudeProviderId;
  routerProviderId?: string;
}

export interface ConnectionState {
  advancedConnectionSnapshot: AdvancedConnectionSnapshot | undefined;
  adviceRefreshInProgress: boolean;
  automaticConnectionTestSessions: Set<string>;
  connectionAdviceState: ClaudeConnectionAdvice | undefined;
  connectionRemedyInProgress: boolean;
  connectionTestInProgress: boolean;
  gatewayDiagnostics: ClaudeGatewayDiagnostics | undefined;
  gatewayRefreshInProgress: boolean;
  gatewayRefreshTimer: number | undefined;
  lastCurlAnalysis: ClaudeCurlAnalysis | undefined;
}

export const createConnectionState = (): ConnectionState => ({
  advancedConnectionSnapshot: undefined,
  adviceRefreshInProgress: false,
  automaticConnectionTestSessions: new Set<string>(),
  connectionAdviceState: undefined,
  connectionRemedyInProgress: false,
  connectionTestInProgress: false,
  gatewayDiagnostics: undefined,
  gatewayRefreshInProgress: false,
  gatewayRefreshTimer: undefined,
  lastCurlAnalysis: undefined,
});
