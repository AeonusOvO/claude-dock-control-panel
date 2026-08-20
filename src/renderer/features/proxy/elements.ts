import { requiredElement } from '../../platform/dom';

export interface ProxyElements {
  candidates: HTMLElement;
  configuration: HTMLElement;
  credentialStatus: HTMLElement;
  detect: HTMLButtonElement;
  enabled: HTMLInputElement;
  host: HTMLInputElement;
  password: HTMLInputElement;
  port: HTMLInputElement;
  protocol: HTMLSelectElement;
  save: HTMLButtonElement;
  scope: HTMLElement;
  scopeApplication: HTMLInputElement;
  scopeCli: HTMLInputElement;
  scopeConversation: HTMLInputElement;
  scopeSummary: HTMLElement;
  test: HTMLButtonElement;
  testResult: HTMLElement;
  username: HTMLInputElement;
}

export const createProxyElements = (): ProxyElements => ({
  candidates: requiredElement('#application-proxy-candidates'),
  configuration: requiredElement('#application-proxy-configuration'),
  credentialStatus: requiredElement('#application-proxy-credential-status'),
  detect: requiredElement('#application-proxy-detect'),
  enabled: requiredElement('#application-proxy-enabled'),
  host: requiredElement('#application-proxy-host'),
  password: requiredElement('#application-proxy-password'),
  port: requiredElement('#application-proxy-port'),
  protocol: requiredElement('#application-proxy-protocol'),
  save: requiredElement('#application-proxy-save'),
  scope: requiredElement('#application-proxy-scope'),
  scopeApplication: requiredElement('#application-proxy-scope-application'),
  scopeCli: requiredElement('#application-proxy-scope-cli'),
  scopeConversation: requiredElement('#application-proxy-scope-conversation'),
  scopeSummary: requiredElement('#application-proxy-scope-summary'),
  test: requiredElement('#application-proxy-test'),
  testResult: requiredElement('#application-proxy-test-result'),
  username: requiredElement('#application-proxy-username'),
});
