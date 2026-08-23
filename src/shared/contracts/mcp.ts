import type { FailureMetadata } from '../diagnostics/failure';

export type McpHealth = 'connected' | 'disabled' | 'failed' | 'unknown';

export type McpScope = 'local' | 'project' | 'user';

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServerView {
  client: 'claude' | 'codex';
  configPath: string;
  enabled: boolean;
  health: McpHealth;
  healthDetail?: string;
  name: string;
  scope: McpScope;
  toggleSupported: boolean;
  transport: McpTransport;
}

export interface McpCatalogEntry {
  description: string;
  featured: boolean;
  id: string;
  installable: boolean;
  name: string;
  requiresCredential: boolean;
  transport: McpTransport;
}

export interface McpCatalog {
  available: McpCatalogEntry[];
  checkedAt: number;
  installed: McpServerView[];
  message: string;
  registryAvailable: boolean;
}

export interface McpBackupView {
  createdAt: number;
  id: string;
  path: string;
}

export interface McpInstallInput {
  catalogId: string;
  cwd: string;
  scope: McpScope;
}

export interface McpRemoveInput {
  cwd: string;
  name: string;
  scope: McpScope;
}

export interface McpTogglePreview {
  after: string;
  before: string;
  enabled: boolean;
  id: string;
  name: string;
  targetPath: string;
}

export interface McpOperationResult extends FailureMetadata {
  catalog: McpCatalog;
  error?: string;
  message: string;
  ok: boolean;
}
