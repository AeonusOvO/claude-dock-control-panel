import type { ClaudePreset } from './claude';
import type { TerminalThemeId } from '../ui/terminal-themes';

export interface ModelTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Small, credential-free snapshot shared by the model card and the optional floating window. */
export interface ModelUsageSnapshot {
  revision: number;
  mode: 'none' | 'api' | 'subscription';
  status: 'available' | 'unavailable' | 'stale';
  preset?: ClaudePreset;
  model?: string;
  connectedAt?: number;
  updatedAt?: number;
  tokens?: ModelTokenUsage;
  windows?: { label: string; remainingPercent: number; resetsAt?: number }[];
  detail: string;
  floating: boolean;
  themeId: TerminalThemeId;
}
