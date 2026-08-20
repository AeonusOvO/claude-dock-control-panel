export type ResourceAvailability = 'available' | 'stale' | 'unavailable';

export type ResourceUsageSource =
  | 'claude-agent-sdk'
  | 'claude-configured-target'
  | 'claude-statusline'
  | 'codex-app-server'
  | 'deepseek-balance'
  | 'openrouter-key'
  | 'managed-chatgpt-gateway';

export interface ResourceCapabilities {
  balance: boolean;
  context: boolean;
  windows: boolean;
}

export interface ResourceWindow {
  label: string;
  resetsAt?: number;
  usedPercent?: number;
  windowDurationMins?: number;
}

export interface ResourceBalanceEntry {
  amount: number;
  currency: string;
}

export interface ResourceBalance {
  balances?: ResourceBalanceEntry[];
  limit?: number;
  unlimited?: boolean;
  used?: number;
}

export interface ResourceUsageView {
  availability: ResourceAvailability;
  autoCompactAtTokens?: number;
  balance?: ResourceBalance;
  capabilities: ResourceCapabilities;
  checkedAt: number;
  /**
   * Set when the status line's raw input counter and its window-clamped usage disagree. This proves
   * a counting/configuration mismatch, not the upstream endpoint's actual context capacity.
   */
  contextCountingAnomaly?: ContextCountingAnomaly;
  contextUsedPercent?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  detail?: string;
  source: ResourceUsageSource;
  staleAt?: number;
  windows?: ResourceWindow[];
}

export interface ContextCountingAnomaly {
  /** Raw `total_input_tokens` from the status line, never clamped to the window. */
  reportedTokens: number;
  /** The window Claude Code believed it had while reporting the value above. */
  windowTokens: number;
}
