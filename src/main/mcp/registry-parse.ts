import { registryError } from './registry-errors';
import type { McpRegistryJsonValue } from './registry-types';

export const isRegistryRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const malformed = (message: string): never => {
  throw registryError('normalize', 'malformed-record', message);
};

export const requireRegistryRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRegistryRecord(value)) return malformed(`${label} must be an object.`);
  return value;
};

export const requiredRegistryString = (
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: { max?: number; min?: number } = {},
): string => {
  const value = record[key];
  const min = options.min ?? 0;
  if (
    typeof value !== 'string' ||
    value.length < min ||
    (options.max !== undefined && value.length > options.max)
  ) {
    return malformed(`${label}.${key} must be a bounded string.`);
  }
  return value;
};

export const optionalRegistryString = (
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: { max?: number; min?: number; pattern?: RegExp } = {},
): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length < (options.min ?? 0) ||
    (options.max !== undefined && value.length > options.max) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return malformed(`${label}.${key} must be a valid bounded string.`);
  }
  return value;
};

export const optionalRegistryBoolean = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') return malformed(`${label}.${key} must be a boolean.`);
  return value;
};

export const optionalRegistryArray = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): unknown[] | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return malformed(`${label}.${key} must be an array.`);
  return value;
};

export const optionalRegistryRecord = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isRegistryRecord(value)) return malformed(`${label}.${key} must be an object.`);
  return value;
};

export const optionalRegistryEnum = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  label: string,
  values: readonly T[],
): T | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return malformed(`${label}.${key} has an unsupported value.`);
  }
  return value as T;
};

export const assertRegistryKeys = (
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void => {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    malformed(`${label} contains unsupported fields.`);
  }
};

const cloneJson = (
  value: unknown,
  depth: number,
  budget: { remaining: number },
): McpRegistryJsonValue => {
  if (budget.remaining <= 0 || depth > 32) malformed('Registry metadata is too complex.');
  budget.remaining -= 1;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1, budget));
  if (isRegistryRecord(value)) {
    const output = Object.create(null) as Record<string, McpRegistryJsonValue>;
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneJson(item, depth + 1, budget);
    }
    return output;
  }
  return malformed('Registry metadata must contain only JSON values.');
};

export const cloneRegistryJsonObject = (
  value: Record<string, unknown>,
): { [key: string]: McpRegistryJsonValue } =>
  cloneJson(value, 0, { remaining: 100_000 }) as { [key: string]: McpRegistryJsonValue };
