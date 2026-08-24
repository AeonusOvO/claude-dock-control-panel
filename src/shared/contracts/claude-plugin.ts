import type { FailureMetadata } from '../diagnostics/failure';

export type ClaudePluginScope = 'local' | 'project' | 'user';

export interface ClaudePluginView {
  description: string;
  enabled: boolean;
  installCount?: number;
  installed: boolean;
  latestVersion?: string;
  marketplaceName: string;
  name: string;
  pluginId: string;
  scope?: ClaudePluginScope;
  sourceLabel: string;
  sourceRevision?: string;
  latestSourceRevision?: string;
  updateAvailable: boolean;
  version?: string;
}

export interface ClaudePluginMarketplaceView {
  installLocation?: string;
  name: string;
  repo?: string;
  source: string;
}

export type ClaudePluginOperationKind =
  | 'disable'
  | 'enable'
  | 'install'
  | 'marketplace-add'
  | 'marketplace-remove'
  | 'refresh'
  | 'uninstall'
  | 'update'
  | 'update-all';

export interface ClaudePluginOperationView {
  attempt: number;
  kind: ClaudePluginOperationKind;
  phase: 'mutating' | 'refreshing';
  startedAt: number;
  target: string;
}

export interface ClaudePluginCatalog {
  activeOperation?: ClaudePluginOperationView;
  available: ClaudePluginView[];
  checkedAt: number;
  cliAvailable: boolean;
  installed: ClaudePluginView[];
  marketplaces: ClaudePluginMarketplaceView[];
  message: string;
  updatesAvailable: number;
}

export interface ClaudePluginOperationResult extends FailureMetadata {
  catalog: ClaudePluginCatalog;
  error?: string;
  message: string;
  ok: boolean;
}
