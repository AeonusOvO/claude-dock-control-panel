import type { ClaudeContextWindowMode } from './contracts';

export const CLAUDE_ONE_MILLION_CONTEXT_SUFFIX = '[1m]';

const CLAUDE_ONE_MILLION_CONTEXT_SUFFIX_PATTERN = /(?:\[1m\])+$/i;
const CLAUDE_ONE_MILLION_CONTEXT_ALIASES = new Set(['fable', 'opus', 'sonnet']);

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsDelimitedModelId = (container: string, model: string): boolean =>
  new RegExp(`(?:^|[/:._-])${escapeRegularExpression(model)}(?:$|[/:._-])`).test(container);

/** Removes only Claude Code's trailing context modifier, never brackets inside a gateway model id. */
export const stripClaudeContextWindowSuffix = (model: string): string =>
  model.trim().replace(CLAUDE_ONE_MILLION_CONTEXT_SUFFIX_PATTERN, '');

export const hasClaudeOneMillionContextSuffix = (model: string): boolean =>
  /\[1m\]$/i.test(model.trim());

const supportsClaudeContextWindowSuffix = (model: string): boolean => {
  const canonical = stripClaudeContextWindowSuffix(model).toLowerCase();
  return canonical.startsWith('claude-') || CLAUDE_ONE_MILLION_CONTEXT_ALIASES.has(canonical);
};

/**
 * Produces the model id Claude Code itself should see. The persisted/gateway-facing id stays
 * canonical; Claude Code consumes this modifier to select its 1M context profile and strips it
 * before dispatching the upstream request.
 */
export const resolveClaudeRuntimeModel = (
  model: string,
  mode: ClaudeContextWindowMode,
  customTokens?: number,
): string => {
  const trimmed = model.trim();
  if (mode === 'auto') return trimmed;

  const canonical = stripClaudeContextWindowSuffix(trimmed);
  const requestsOneMillion =
    mode === 'extended' || (mode === 'custom' && customTokens === 1_000_000);
  return requestsOneMillion && supportsClaudeContextWindowSuffix(canonical)
    ? `${canonical}${CLAUDE_ONE_MILLION_CONTEXT_SUFFIX}`
    : canonical;
};

/** Matches status-line/runtime ids without making `[1m]` part of model identity. */
export const claudeModelIdsMatch = (
  expected: string | undefined,
  actual: string | undefined,
): boolean => {
  if (!expected || expected.toLowerCase() === 'default' || !actual) return true;
  const normalizedExpected = stripClaudeContextWindowSuffix(expected).toLowerCase();
  const normalizedActual = stripClaudeContextWindowSuffix(actual).toLowerCase();
  if (normalizedActual === normalizedExpected) return true;
  return containsDelimitedModelId(normalizedActual, normalizedExpected);
};
