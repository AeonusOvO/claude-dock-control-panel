export const MCP_REGISTRY_SNAPSHOT_VERSION = 2 as const;

export type McpRegistryStatus = 'active' | 'deprecated' | 'deleted';
export type McpRegistryInputFormat = 'string' | 'number' | 'boolean' | 'filepath';
export type McpRegistryHttpTransportType = 'sse' | 'streamable-http';
export type McpRegistryTransportType = 'stdio' | McpRegistryHttpTransportType;
export type McpRegistrySyncKind = 'full' | 'incremental';

export type McpRegistryJsonValue =
  | boolean
  | number
  | string
  | null
  | McpRegistryJsonValue[]
  | { [key: string]: McpRegistryJsonValue };

export interface McpRegistryInputFields {
  choices?: string[];
  default?: string;
  description?: string;
  format?: McpRegistryInputFormat;
  isRequired?: boolean;
  isSecret?: boolean;
  placeholder?: string;
  value?: string;
  variables?: McpRegistryVariableDescriptor[];
}

export interface McpRegistryVariableDescriptor extends McpRegistryInputFields {
  id: string;
  name: string;
}

export interface McpRegistryKeyValueDescriptor extends McpRegistryInputFields {
  id: string;
  name: string;
}

export interface McpRegistryPositionalArgument extends McpRegistryInputFields {
  id: string;
  isRepeated?: boolean;
  type: 'positional';
  valueHint?: string;
}

export interface McpRegistryNamedArgument extends McpRegistryInputFields {
  id: string;
  isRepeated?: boolean;
  name: string;
  type: 'named';
}

export type McpRegistryArgument = McpRegistryPositionalArgument | McpRegistryNamedArgument;

export interface McpRegistryStdioTransport {
  type: 'stdio';
}

export interface McpRegistryHttpTransport {
  headers?: McpRegistryKeyValueDescriptor[];
  type: McpRegistryHttpTransportType;
  url: string;
}

export type McpRegistryLocalTransport = McpRegistryStdioTransport | McpRegistryHttpTransport;

export interface McpRegistryPackageAlternative {
  environmentVariables?: McpRegistryKeyValueDescriptor[];
  fileSha256?: string;
  id: string;
  identifier: string;
  packageArguments?: McpRegistryArgument[];
  registryBaseUrl?: string;
  registryType: string;
  runtimeArguments?: McpRegistryArgument[];
  runtimeHint?: string;
  transport: McpRegistryLocalTransport;
  version?: string;
}

export interface McpRegistryRemoteAlternative extends McpRegistryHttpTransport {
  id: string;
  variables?: McpRegistryVariableDescriptor[];
}

export interface McpRegistryRepository {
  id?: string;
  source: string;
  subfolder?: string;
  url: string;
}

export interface McpRegistryIcon {
  mimeType?: 'image/jpeg' | 'image/jpg' | 'image/png' | 'image/svg+xml' | 'image/webp';
  sizes?: string[];
  src: string;
  theme?: 'dark' | 'light';
}

export interface McpRegistryOfficialMetadata {
  isLatest?: boolean;
  publishedAt?: string;
  status?: McpRegistryStatus;
  statusChangedAt?: string;
  statusMessage?: string;
  updatedAt?: string;
}

export interface McpRegistryRecord {
  catalogMetadata?: { [key: string]: McpRegistryJsonValue };
  description: string;
  icons?: McpRegistryIcon[];
  identity: string;
  name: string;
  official: McpRegistryOfficialMetadata;
  packages?: McpRegistryPackageAlternative[];
  registryExtensions?: { [key: string]: McpRegistryJsonValue };
  remotes?: McpRegistryRemoteAlternative[];
  repository?: McpRegistryRepository;
  schemaUrl?: string;
  title?: string;
  version: string;
  websiteUrl?: string;
}

export interface McpRegistrySnapshot {
  records: McpRegistryRecord[];
  synchronizedThrough: string;
  version: typeof MCP_REGISTRY_SNAPSHOT_VERSION;
}

export interface McpRegistryClientLimits {
  maxAggregateBytes: number;
  maxCursorBytes: number;
  maxPageBytes: number;
  maxPages: number;
  maxRecords: number;
  pageLimit: number;
  timeoutMs: number;
}

export interface McpRegistryPageSet {
  pages: unknown[][];
  recordCount: number;
  totalBytes: number;
}

export type McpRegistryFailureStage =
  'bounds' | 'fetch' | 'normalize' | 'parse' | 'persist' | 'snapshot';

export type McpRegistryFailureCode =
  | 'aggregate-too-large'
  | 'canonical-collision'
  | 'cursor-too-large'
  | 'empty-full-result'
  | 'http-error'
  | 'malformed-page'
  | 'malformed-record'
  | 'page-limit'
  | 'page-too-large'
  | 'persist-failed'
  | 'record-limit'
  | 'redirect-rejected'
  | 'repeated-cursor'
  | 'request-failed'
  | 'snapshot-invalid'
  | 'snapshot-oversized'
  | 'snapshot-version-unsupported'
  | 'snapshot-watermark-untrusted';

interface McpRegistryStateBase {
  records: readonly McpRegistryRecord[];
  synchronizedThrough?: string;
}

export interface McpRegistryCuratedOnlyState extends McpRegistryStateBase {
  mode: 'curated-only';
  records: readonly [];
}

export interface McpRegistrySnapshotState extends McpRegistryStateBase {
  loadedFrom: 'backup' | 'primary';
  mode: 'snapshot';
  synchronizedThrough: string;
}

export interface McpRegistryLiveState extends McpRegistryStateBase {
  mode: 'live';
  synchronizedThrough: string;
  syncKind: McpRegistrySyncKind;
}

export interface McpRegistryDegradedState extends McpRegistryStateBase {
  failure: {
    code: McpRegistryFailureCode;
    stage: McpRegistryFailureStage;
  };
  fallback: 'curated-only' | 'live' | 'snapshot';
  mode: 'degraded';
}

export type McpRegistryState =
  | McpRegistryCuratedOnlyState
  | McpRegistryDegradedState
  | McpRegistryLiveState
  | McpRegistrySnapshotState;

export type McpRegistrySnapshotLoadResult =
  | {
      kind: 'empty';
      rejected?: 'invalid' | 'oversized';
    }
  | {
      kind: 'snapshot';
      requiresFullSync?: true;
      snapshot: McpRegistrySnapshot;
      source: 'backup' | 'primary';
    }
  | {
      kind: 'unsupported';
      source: 'backup' | 'primary';
      version: number;
    };
