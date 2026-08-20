import { requiredElement } from '../../platform/dom';

export interface ConnectionElements {
  analyzeCurlButton: HTMLButtonElement;
  applyCurlDirectButton: HTMLButtonElement;
  configurationHints: HTMLElement;
  connectionAdviceActions: HTMLElement;
  connectionAdviceDetail: HTMLElement;
  connectionAdviceTitle: HTMLElement;
  connectionRailDot: HTMLElement;
  connectionRemedy: HTMLElement;
  connectionRemedyCause: HTMLElement;
  connectionRemedyFix: HTMLElement;
  connectionRemedyTitle: HTMLElement;
  connectionTestResult: HTMLElement;
  connectionTestStages: HTMLElement;
  connectionTestSummary: HTMLElement;
  connectionTestTitle: HTMLElement;
  curlAnalysis: HTMLElement;
  curlAnalysisAuth: HTMLElement;
  curlAnalysisDetail: HTMLElement;
  curlAnalysisEndpoint: HTMLElement;
  curlAnalysisModel: HTMLElement;
  curlAnalysisTitle: HTMLElement;
  curlInput: HTMLTextAreaElement;
  curlNextStep: HTMLElement;
  curlProtocolBadge: HTMLElement;
  gatewayCandidates: HTMLElement;
  gatewayCheckedAt: HTMLElement;
  gatewayDiagnosticsSummary: HTMLElement;
  openDetectedRouterButton: HTMLButtonElement;
  refreshGatewaysButton: HTMLButtonElement;
  smartGuidance: HTMLElement;
  smartGuidanceActions: HTMLElement;
  smartGuidanceDetail: HTMLElement;
  smartGuidanceTitle: HTMLElement;
  testClaudeConnectionButton: HTMLButtonElement;
  useDetectedRouterButton: HTMLButtonElement;
}

export const createConnectionElements = (): ConnectionElements => ({
  analyzeCurlButton: requiredElement<HTMLButtonElement>('#analyze-curl'),
  applyCurlDirectButton: requiredElement<HTMLButtonElement>('#apply-curl-direct'),
  configurationHints: requiredElement<HTMLElement>('#configuration-hints'),
  connectionAdviceActions: requiredElement<HTMLElement>('#connection-advice-actions'),
  connectionAdviceDetail: requiredElement<HTMLElement>('#connection-advice-detail'),
  connectionAdviceTitle: requiredElement<HTMLElement>('#connection-advice-title'),
  connectionRailDot: requiredElement<HTMLElement>('#connection-rail-dot'),
  connectionRemedy: requiredElement<HTMLElement>('#connection-remedy'),
  connectionRemedyCause: requiredElement<HTMLElement>('#connection-remedy-cause'),
  connectionRemedyFix: requiredElement<HTMLElement>('#connection-remedy-fix'),
  connectionRemedyTitle: requiredElement<HTMLElement>('#connection-remedy-title'),
  connectionTestResult: requiredElement<HTMLElement>('#connection-test-result'),
  connectionTestStages: requiredElement<HTMLElement>('#connection-test-stages'),
  connectionTestSummary: requiredElement<HTMLElement>('#connection-test-summary'),
  connectionTestTitle: requiredElement<HTMLElement>('#connection-test-title'),
  curlAnalysis: requiredElement<HTMLElement>('#curl-analysis'),
  curlAnalysisAuth: requiredElement<HTMLElement>('#curl-analysis-auth'),
  curlAnalysisDetail: requiredElement<HTMLElement>('#curl-analysis-detail'),
  curlAnalysisEndpoint: requiredElement<HTMLElement>('#curl-analysis-endpoint'),
  curlAnalysisModel: requiredElement<HTMLElement>('#curl-analysis-model'),
  curlAnalysisTitle: requiredElement<HTMLElement>('#curl-analysis-title'),
  curlInput: requiredElement<HTMLTextAreaElement>('#curl-input'),
  curlNextStep: requiredElement<HTMLElement>('#curl-next-step'),
  curlProtocolBadge: requiredElement<HTMLElement>('#curl-protocol-badge'),
  gatewayCandidates: requiredElement<HTMLElement>('#gateway-candidates'),
  gatewayCheckedAt: requiredElement<HTMLElement>('#gateway-checked-at'),
  gatewayDiagnosticsSummary: requiredElement<HTMLElement>('#gateway-diagnostics-summary'),
  openDetectedRouterButton: requiredElement<HTMLButtonElement>('#open-detected-router'),
  refreshGatewaysButton: requiredElement<HTMLButtonElement>('#refresh-gateways'),
  smartGuidance: requiredElement<HTMLElement>('#smart-guidance'),
  smartGuidanceActions: requiredElement<HTMLElement>('#smart-guidance-actions'),
  smartGuidanceDetail: requiredElement<HTMLElement>('#smart-guidance-detail'),
  smartGuidanceTitle: requiredElement<HTMLElement>('#smart-guidance-title'),
  testClaudeConnectionButton: requiredElement<HTMLButtonElement>('#test-claude-connection'),
  useDetectedRouterButton: requiredElement<HTMLButtonElement>('#use-detected-router'),
});
