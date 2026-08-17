export const CLAUDE_CONTEXT_WINDOW_MIN_TOKENS = 8_000;
export const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = 2_000_000;

export const isValidClaudeCustomContextWindow = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= CLAUDE_CONTEXT_WINDOW_MIN_TOKENS &&
  value <= CLAUDE_CONTEXT_WINDOW_MAX_TOKENS;
