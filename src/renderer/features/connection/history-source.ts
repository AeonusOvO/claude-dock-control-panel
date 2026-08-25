import { findClaudeProvider, type ClaudeProviderId } from '../../../shared/claude/providers';
import type { ClaudeConnectionHistoryEntry } from '../../../shared/contracts';

export type ConnectionModelSource =
  'api' | 'chatgpt-subscription' | 'claude-subscription' | 'domestic';

export const CONNECTION_MODEL_SOURCE_LABELS: Readonly<Record<ConnectionModelSource, string>> = {
  api: 'API / 中转站',
  'chatgpt-subscription': 'ChatGPT 官方订阅',
  // `anthropic` means Claude Code's existing first-party login. Calling this “当前的官方订阅”
  // would be ambiguous beside ChatGPT, so the source is named explicitly.
  'claude-subscription': 'Claude 官方订阅',
  domestic: '国产模型',
};

export const connectionModelSourceForProvider = (
  providerId: ClaudeProviderId | undefined,
): ConnectionModelSource | undefined => {
  if (providerId === 'anthropic') return 'claude-subscription';
  if (providerId === 'chatgpt-subscription') return 'chatgpt-subscription';
  if (findClaudeProvider(providerId)?.group === 'domestic') return 'domestic';
  return providerId ? 'api' : undefined;
};

export const connectionModelSourceForHistoryEntry = (
  entry: ClaudeConnectionHistoryEntry,
): ConnectionModelSource => connectionModelSourceForProvider(entry.preset) ?? 'api';

export const filterConnectionHistoryBySource = (
  entries: readonly ClaudeConnectionHistoryEntry[],
  source: ConnectionModelSource | undefined,
): ClaudeConnectionHistoryEntry[] =>
  source ? entries.filter((entry) => connectionModelSourceForHistoryEntry(entry) === source) : [];
