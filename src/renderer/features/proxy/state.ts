import type { ApplicationProxyView } from '../../../shared/contracts';

export interface ApplicationProxyDraftSnapshot {
  enabled: boolean;
  host: string;
  port: string;
  protocol: 'http' | 'socks5';
  scope: {
    application: boolean;
    cli: boolean;
    conversation: boolean;
  };
  username: string;
}

export interface ProxyState {
  cancelBaseline?: ApplicationProxyDraftSnapshot;
  draftEdited: boolean;
  initialLoadPending: boolean;
  loadGeneration: number;
  saveInProgress: boolean;
  saved?: ApplicationProxyView;
  testInProgress: boolean;
}

export const createProxyState = (): ProxyState => ({
  draftEdited: false,
  initialLoadPending: false,
  loadGeneration: 0,
  saveInProgress: false,
  testInProgress: false,
});
