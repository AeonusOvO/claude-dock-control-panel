import type {
  ClaudeEffortLevel,
  ClaudeMetrics,
  ManagedChatGptContextWindowMode,
  ResourceUsageView,
} from '../../shared/contracts';
import { CLAUDE_EFFORT_LEVELS } from '../../shared/claude/effort';
import { managedChatGptContextProfile, type NormalizedClaudeConfig } from './configuration';

const METRICS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const optionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 1000 ? value : undefined;

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const optionalEffortLevel = (value: unknown): ClaudeEffortLevel | undefined =>
  typeof value === 'string' && CLAUDE_EFFORT_LEVELS.has(value as ClaudeEffortLevel)
    ? (value as ClaudeEffortLevel)
    : undefined;

export const claudeResourceUsage = (
  metrics: ClaudeMetrics | undefined,
  config: NormalizedClaudeConfig,
  contextWindowMode: ManagedChatGptContextWindowMode,
): ResourceUsageView => {
  const contextProfile = managedChatGptContextProfile(config, contextWindowMode);
  const checkedAt = metrics?.capturedAt ?? Date.now();
  const autoCompactAtTokens = contextProfile
    ? ((metrics?.contextWindowSize
        ? Math.min(metrics.contextWindowSize, contextProfile.effectiveContextWindowTokens)
        : contextProfile.effectiveContextWindowTokens) *
        contextProfile.autoCompactPercent) /
      100
    : undefined;
  /*
   * `contextWindowUsed` is clamped to the window by the status line, so a window that is smaller
   * than what the endpoint actually serves shows a permanent 100%. `inputTokens` carries the raw
   * total, and its overshoot is the only evidence available from outside the CLI that the declared
   * window is wrong. Report the real ratio rather than the clamped one so the bar keeps moving.
   */
  const contextCountingAnomaly =
    metrics?.contextWindowSize &&
    metrics.contextWindowUsed === metrics.contextWindowSize &&
    metrics.inputTokens !== undefined &&
    metrics.inputTokens > metrics.contextWindowSize
      ? { reportedTokens: metrics.inputTokens, windowTokens: metrics.contextWindowSize }
      : undefined;
  const contextUsedPercent = contextCountingAnomaly
    ? (contextCountingAnomaly.reportedTokens / contextCountingAnomaly.windowTokens) * 100
    : metrics?.contextWindowUsed !== undefined && metrics.contextWindowSize
      ? Math.min(100, Math.max(0, (metrics.contextWindowUsed / metrics.contextWindowSize) * 100))
      : undefined;
  const windows = [
    metrics?.rateLimitFiveHour === undefined
      ? undefined
      : {
          label: '5 小时',
          resetsAt: metrics.rateLimitFiveHourResetsAt,
          usedPercent: Math.min(100, Math.max(0, metrics.rateLimitFiveHour)),
          windowDurationMins: 300,
        },
    metrics?.rateLimitSevenDay === undefined
      ? undefined
      : {
          label: '7 天',
          resetsAt: metrics.rateLimitSevenDayResetsAt,
          usedPercent: Math.min(100, Math.max(0, metrics.rateLimitSevenDay)),
          windowDurationMins: 10_080,
        },
  ].filter((window): window is NonNullable<typeof window> => Boolean(window));
  const available = contextUsedPercent !== undefined || windows.length > 0;
  return {
    availability: available ? 'available' : 'unavailable',
    autoCompactAtTokens,
    capabilities: { balance: false, context: true, windows: true },
    checkedAt,
    contextCountingAnomaly,
    contextUsedPercent,
    contextUsedTokens: contextCountingAnomaly?.reportedTokens ?? metrics?.contextWindowUsed,
    contextWindowTokens: metrics?.contextWindowSize,
    detail: available ? undefined : '等待 Claude Code 状态行上报。',
    source: 'claude-statusline',
    staleAt: metrics ? metrics.capturedAt + METRICS_MAX_AGE_MS : undefined,
    windows: windows.length > 0 ? windows : undefined,
  };
};

export const effectiveClaudeMetrics = (
  metrics: ClaudeMetrics | undefined,
  config: NormalizedClaudeConfig,
  contextWindowMode: ManagedChatGptContextWindowMode = 'standard',
): ClaudeMetrics | undefined => {
  const profile = managedChatGptContextProfile(config, contextWindowMode);
  return profile && metrics?.contextWindowSize === profile.contextWindowTokens
    ? { ...metrics, contextWindowSize: profile.effectiveContextWindowTokens }
    : metrics;
};

export const mergeClaudeResourceUsage = (
  context: ResourceUsageView,
  provider: ResourceUsageView | undefined,
): ResourceUsageView =>
  provider
    ? {
        ...provider,
        availability:
          provider.availability === 'available' || context.availability === 'available'
            ? 'available'
            : provider.availability === 'stale' || context.availability === 'stale'
              ? 'stale'
              : 'unavailable',
        autoCompactAtTokens: context.autoCompactAtTokens,
        capabilities: {
          balance: provider.capabilities.balance || context.capabilities.balance,
          context: provider.capabilities.context || context.capabilities.context,
          windows: provider.capabilities.windows || context.capabilities.windows,
        },
        checkedAt: Math.max(provider.checkedAt, context.checkedAt),
        contextCountingAnomaly: context.contextCountingAnomaly,
        contextUsedPercent: context.contextUsedPercent,
        contextUsedTokens: context.contextUsedTokens,
        contextWindowTokens: context.contextWindowTokens,
        windows: context.windows ?? provider.windows,
      }
    : context;

export const parseClaudeMetrics = (raw: string): ClaudeMetrics | undefined => {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const capturedAt = optionalFiniteNumber(parsed.capturedAt);
    if (!capturedAt || Date.now() - capturedAt > METRICS_MAX_AGE_MS) {
      return undefined;
    }

    return {
      capturedAt,
      contextWindowSize: optionalFiniteNumber(parsed.contextWindowSize),
      contextWindowUsed: optionalFiniteNumber(parsed.contextWindowUsed),
      effortLevel: optionalEffortLevel(parsed.effortLevel),
      fastMode: optionalBoolean(parsed.fastMode),
      inputTokens: optionalFiniteNumber(parsed.inputTokens),
      linesAdded: optionalFiniteNumber(parsed.linesAdded),
      linesRemoved: optionalFiniteNumber(parsed.linesRemoved),
      modelDisplayName: optionalString(parsed.modelDisplayName),
      modelId: optionalString(parsed.modelId),
      outputTokens: optionalFiniteNumber(parsed.outputTokens),
      rateLimitFiveHour: optionalFiniteNumber(parsed.rateLimitFiveHour),
      rateLimitFiveHourResetsAt: optionalFiniteNumber(parsed.rateLimitFiveHourResetsAt),
      rateLimitSevenDay: optionalFiniteNumber(parsed.rateLimitSevenDay),
      rateLimitSevenDayResetsAt: optionalFiniteNumber(parsed.rateLimitSevenDayResetsAt),
      sessionCostUsd: optionalFiniteNumber(parsed.sessionCostUsd),
      sessionDurationMs: optionalFiniteNumber(parsed.sessionDurationMs),
      sessionId: optionalString(parsed.sessionId),
      sessionName: optionalString(parsed.sessionName),
    };
  } catch {
    return undefined;
  }
};

export { optionalFiniteNumber, optionalString };
