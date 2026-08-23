import { randomBytes } from 'node:crypto';
import { managedGatewayEnvironmentsEqual } from './managed-chatgpt-config';
import type {
  ManagedGatewayEnvironmentIdentity,
  ManagedGatewayEnvironmentSnapshot,
} from './managed-chatgpt-gateway-types';

export interface ManagedGatewayEnvironmentResolution {
  identity: ManagedGatewayEnvironmentIdentity;
  snapshot: ManagedGatewayEnvironmentSnapshot;
}

/** Reuses a launch identity only while the complete gateway environment stays equal. */
export const resolveManagedGatewayEnvironmentSnapshot = (
  current: ManagedGatewayEnvironmentIdentity | undefined,
  environment: NodeJS.ProcessEnv,
): ManagedGatewayEnvironmentResolution => {
  const identity =
    current && managedGatewayEnvironmentsEqual(current.environment, environment)
      ? current
      : {
          environment: { ...environment },
          identity: randomBytes(16).toString('hex'),
        };
  return {
    identity,
    snapshot: { environment, signature: identity.identity },
  };
};
