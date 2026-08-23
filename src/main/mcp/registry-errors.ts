import type { McpRegistryFailureCode, McpRegistryFailureStage } from './registry-types';

export class McpRegistryError extends Error {
  public constructor(
    public readonly stage: McpRegistryFailureStage,
    public readonly code: McpRegistryFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'McpRegistryError';
  }
}

export const registryError = (
  stage: McpRegistryFailureStage,
  code: McpRegistryFailureCode,
  message: string,
  cause?: unknown,
): McpRegistryError =>
  new McpRegistryError(stage, code, message, cause === undefined ? undefined : { cause });

export const toRegistryFailure = (
  error: unknown,
  fallbackStage: McpRegistryFailureStage,
  fallbackCode: McpRegistryFailureCode,
): { code: McpRegistryFailureCode; stage: McpRegistryFailureStage } =>
  error instanceof McpRegistryError
    ? { code: error.code, stage: error.stage }
    : { code: fallbackCode, stage: fallbackStage };
