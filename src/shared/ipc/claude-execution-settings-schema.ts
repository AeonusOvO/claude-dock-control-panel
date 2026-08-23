import { z } from 'zod';
import { CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION } from '../claude/execution-profiles';
import type {
  ClaudeExecutionSettingsDto,
  ClaudeExecutionSettingsRequest,
  ClaudeToolSearchRequest,
} from '../contracts';
import {
  CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS,
  CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION,
} from '../contracts/claude-execution-settings';

export const claudeExecutionProfileIdSchema = z.enum([
  'balanced',
  'best-performance',
  'high-throughput',
  'restrained',
  'token-saver',
]);

export const claudeToolSearchRequestSchema = z.union([
  z.boolean(),
  z.literal('inherit'),
  z.literal('auto'),
  z
    .string()
    .regex(/^auto:(?:0|[1-9]\d?|100)$/u, '工具搜索请求无效。')
    .transform((value): ClaudeToolSearchRequest => value as ClaudeToolSearchRequest),
]);

export const claudeExecutionRequestedValuesSchema = z
  .object({
    concurrentSubagents: z
      .number()
      .int()
      .min(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.concurrentSubagents.minimum)
      .max(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.concurrentSubagents.maximum),
    spawnDepth: z
      .number()
      .int()
      .min(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.spawnDepth.minimum)
      .max(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.spawnDepth.maximum),
    toolSearch: claudeToolSearchRequestSchema,
    toolUseConcurrency: z
      .number()
      .int()
      .min(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.toolUseConcurrency.minimum)
      .max(CLAUDE_EXECUTION_CUSTOM_NUMERIC_BOUNDS.toolUseConcurrency.maximum),
  })
  .strict();

export const claudeExecutionSettingsRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('claude-default') }).strict(),
  z
    .object({
      mode: z.literal('custom'),
      values: claudeExecutionRequestedValuesSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('profile'),
      profileId: claudeExecutionProfileIdSchema,
    })
    .strict(),
]) satisfies z.ZodType<ClaudeExecutionSettingsRequest>;

const claudeExecutionSourceSchema = z
  .object({
    expiresAt: z.number().int().nonnegative().optional(),
    kind: z.enum([
      'claude-default',
      'requested-inherit',
      'undocumented',
      'verified-evidence',
      'version-matrix',
    ]),
    verifiedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const claudeExecutionNumberSettingDtoSchema = z
  .object({
    defaultValue: z.number().optional(),
    effectiveValue: z.number().optional(),
    reason: z.string(),
    requestedValue: z.number().optional(),
    source: claudeExecutionSourceSchema,
    status: z.enum(['fixed', 'supported', 'unavailable', 'unverified', 'update-required']),
  })
  .strict();

const claudeExecutionToolSearchSettingDtoSchema = z
  .object({
    defaultValue: claudeToolSearchRequestSchema.optional(),
    effectiveValue: claudeToolSearchRequestSchema.optional(),
    reason: z.string(),
    requestedValue: claudeToolSearchRequestSchema.optional(),
    source: claudeExecutionSourceSchema,
    status: z.enum(['fixed', 'supported', 'unavailable', 'unverified', 'update-required']),
  })
  .strict();

export const claudeExecutionSettingsDtoSchema = z
  .object({
    catalogVersion: z.literal(CLAUDE_EXECUTION_PROFILE_CATALOG_VERSION),
    effective: z
      .object({
        concurrentSubagents: claudeExecutionNumberSettingDtoSchema,
        spawnDepth: claudeExecutionNumberSettingDtoSchema,
        toolSearch: claudeExecutionToolSearchSettingDtoSchema,
        toolUseConcurrency: claudeExecutionNumberSettingDtoSchema,
      })
      .strict(),
    installation: z
      .object({
        installed: z.boolean(),
        version: z
          .string()
          .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u)
          .optional(),
      })
      .strict(),
    profiles: z
      .array(
        z
          .object({
            id: claudeExecutionProfileIdSchema,
            label: z.string(),
            values: claudeExecutionRequestedValuesSchema,
          })
          .strict(),
      )
      .length(5)
      .readonly(),
    requested: claudeExecutionSettingsRequestSchema,
    version: z.literal(CLAUDE_EXECUTION_SETTINGS_SCHEMA_VERSION),
  })
  .strict() satisfies z.ZodType<ClaudeExecutionSettingsDto>;

export const parseClaudeExecutionSettingsDto = (value: unknown): ClaudeExecutionSettingsDto =>
  claudeExecutionSettingsDtoSchema.parse(value);
