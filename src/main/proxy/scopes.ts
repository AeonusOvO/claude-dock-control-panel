import { session } from 'electron';
import type { Registry } from '../infra/registry';
import { APPLICATION_PROXY_STORE, CONVERSATION_NETWORK_SESSION } from '../infra/service-tokens';
import type { MainState } from '../ipc/context';
import { applicationProxyRules } from './application-proxy';

export interface ProxyScopeDependencies {
  services: Registry;
  state: MainState;
}

/** One entry point per network scope, so a scope change never reaches the other scope's session. */
export interface ProxyScopes {
  applyApplicationProxyScope: () => Promise<void>;
  applyConversationProxyScope: () => Promise<void>;
}

/** Chromium closes live sockets whenever proxy rules change, so identical rules are de-duplicated. */
export const createProxyScopes = ({ services, state }: ProxyScopeDependencies): ProxyScopes => {
  const applyApplicationProxyScope = async (): Promise<void> => {
    const applicationProxyStore = services.resolve(APPLICATION_PROXY_STORE);
    const rules = applicationProxyRules(applicationProxyStore.getView(), 'application');
    const signature = JSON.stringify(rules);
    if (signature === state.appliedApplicationProxyRules) return;
    state.appliedApplicationProxyRules = signature;
    await session.defaultSession.setProxy(rules);
    await session.defaultSession.closeAllConnections();
  };

  const applyConversationProxyScope = async (): Promise<void> => {
    const applicationProxyStore = services.resolve(APPLICATION_PROXY_STORE);
    const conversationNetworkSession = services.resolve(CONVERSATION_NETWORK_SESSION);
    const rules = applicationProxyRules(applicationProxyStore.getView(), 'conversation');
    const signature = JSON.stringify(rules);
    if (signature === state.appliedConversationProxyRules) return;
    state.appliedConversationProxyRules = signature;
    await conversationNetworkSession.setProxy(rules);
    await conversationNetworkSession.closeAllConnections();
  };

  return { applyApplicationProxyScope, applyConversationProxyScope };
};
