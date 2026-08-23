import type { GatewayConfigTransaction } from './managed-chatgpt-config-files';
import type { PersistedGatewayState } from './managed-chatgpt-state';

export interface ManagedGatewayEnvironmentSnapshot {
  environment: NodeJS.ProcessEnv;
  signature: string;
}

export interface PreparedGatewayConfiguration {
  config: string;
  configSignature: string;
  state: PersistedGatewayState;
}

export interface ManagedGatewayConfigurationIdentity {
  encryptedClientKey: string;
  encryptedManagementKey: string;
  identity: string;
  port: number;
}

export interface ManagedGatewayEnvironmentIdentity {
  environment: NodeJS.ProcessEnv;
  identity: string;
}

export interface ManagedGatewayConfigurationCommit {
  snapshot: ManagedGatewayEnvironmentSnapshot;
  state: PersistedGatewayState;
  transaction: GatewayConfigTransaction;
}

export type ManagedChatGptSetupReporter = (step: number, detail: string) => void;

export interface ManagedChatGptGatewayManagementAccess {
  url: string;
}

export class ManagedGatewayEnvironmentChangedError extends Error {
  public constructor() {
    super('托管网关启动期间应用网络环境发生变化，本次启动结果已作废。');
    this.name = 'ManagedGatewayEnvironmentChangedError';
  }
}

export const managedGatewayDelay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
