import { describe, expect, it } from 'vitest';
import type { ClaudeConnectionHistoryEntry } from '../../src/shared/contracts';
import { CLAUDE_PROVIDERS } from '../../src/shared/claude/providers';
import {
  CONNECTION_MODEL_SOURCE_LABELS,
  connectionModelSourceForHistoryEntry,
  connectionModelSourceForProvider,
  filterConnectionHistoryBySource,
} from '../../src/renderer/features/connection/history-source';
import { withTerminalRenderer } from '../helpers/renderer-interaction-fixture';
import { claudeProjectState } from '../helpers/renderer-terminal-fixture';

const historyEntry = (
  id: string,
  preset: ClaudeConnectionHistoryEntry['preset'],
): ClaudeConnectionHistoryEntry => ({
  apiKeyHelperPolicy: 'inherit',
  authMode: preset === 'anthropic' ? 'existing' : 'authToken',
  baseUrl: preset === 'anthropic' ? '' : `https://${id}.example.test`,
  credentialConfigured: preset !== 'anthropic',
  gatewayState: 'unknown',
  id,
  model: 'model',
  preset,
  protocol: 'anthropic',
  provider: preset === 'anthropic' || preset === 'anthropic-api' ? 'anthropic' : 'gateway',
  savedAt: 1,
});

describe('connection history model sources', () => {
  it('uses four explicit user-facing source names without an ambiguous official label', () => {
    expect(CONNECTION_MODEL_SOURCE_LABELS).toEqual({
      api: 'API / 中转站',
      'chatgpt-subscription': 'ChatGPT 官方订阅',
      'claude-subscription': 'Claude 官方订阅',
      domestic: '国产模型',
    });
  });

  it.each([
    ['anthropic', 'claude-subscription'],
    ['chatgpt-subscription', 'chatgpt-subscription'],
    ['deepseek', 'domestic'],
    ['qwen-cn', 'domestic'],
    ['anthropic-api', 'api'],
    ['qwen-global', 'api'],
    ['ollama', 'api'],
    ['custom', 'api'],
    ['gateway', 'api'],
  ] as const)('maps provider %s to %s', (providerId, source) => {
    expect(connectionModelSourceForProvider(providerId)).toBe(source);
    expect(connectionModelSourceForHistoryEntry(historyEntry(providerId, providerId))).toBe(source);
  });

  it('classifies every provider in the catalog without falling through an undefined source', () => {
    for (const provider of CLAUDE_PROVIDERS) {
      const expected =
        provider.id === 'anthropic'
          ? 'claude-subscription'
          : provider.id === 'chatgpt-subscription'
            ? 'chatgpt-subscription'
            : provider.group === 'domestic'
              ? 'domestic'
              : 'api';
      expect(connectionModelSourceForProvider(provider.id), provider.id).toBe(expected);
    }
  });

  it('shows only the selected source in the main flow while retaining the full input list', () => {
    const entries = [
      historyEntry('claude', 'anthropic'),
      historyEntry('chatgpt', 'chatgpt-subscription'),
      historyEntry('deepseek', 'deepseek'),
      historyEntry('glm', 'glm-cn'),
      historyEntry('anthropic-api', 'anthropic-api'),
      historyEntry('relay', 'custom'),
    ];

    expect(
      filterConnectionHistoryBySource(entries, 'claude-subscription').map(({ id }) => id),
    ).toEqual(['claude']);
    expect(
      filterConnectionHistoryBySource(entries, 'chatgpt-subscription').map(({ id }) => id),
    ).toEqual(['chatgpt']);
    expect(filterConnectionHistoryBySource(entries, 'domestic').map(({ id }) => id)).toEqual([
      'deepseek',
      'glm',
    ]);
    expect(filterConnectionHistoryBySource(entries, 'api').map(({ id }) => id)).toEqual([
      'anthropic-api',
      'relay',
    ]);
    expect(filterConnectionHistoryBySource(entries, undefined)).toEqual([]);
    expect(entries).toHaveLength(6);
  });
});

describe('connection history source rendering', () => {
  it('keeps the full history available while the main list follows the selected provider', async () => {
    const entries = [
      historyEntry('claude', 'anthropic'),
      historyEntry('chatgpt', 'chatgpt-subscription'),
      historyEntry('deepseek', 'deepseek'),
      historyEntry('relay', 'custom'),
    ];
    await withTerminalRenderer(
      {
        getClaudeConnectionHistory: async () => entries,
        getNextClaudeConnection: async () => ({ config: claudeProjectState().config }),
      },
      async (harness) => {
        const renderedIds = (): string[] =>
          Array.from(
            harness.document.querySelectorAll<HTMLElement>(
              '#connection-history-list [data-history-id]',
            ),
          ).map(({ dataset }) => dataset.historyId ?? '');

        expect(renderedIds()).toEqual(['claude']);
        expect(
          Array.from(
            harness.document.querySelectorAll<HTMLElement>(
              '#connection-history-dialog [data-history-id]',
            ),
            ({ dataset }) => dataset.historyId,
          ),
        ).toEqual(['claude', 'chatgpt', 'deepseek', 'relay']);
        const initialLoads = harness.method('getClaudeConnectionHistory').mock.calls.length;

        harness.click('[data-rail-tab="connection"]');
        harness.click('[data-provider-id="deepseek"]');
        expect(renderedIds()).toEqual(['deepseek']);

        harness.click('[data-provider-id="custom"]');
        expect(renderedIds()).toEqual(['relay']);

        harness.click('[data-provider-id="chatgpt-subscription"]');
        expect(renderedIds()).toEqual(['chatgpt']);

        harness.click('[data-provider-id="anthropic"]');
        expect(renderedIds()).toEqual(['claude']);
        expect(harness.method('getClaudeConnectionHistory')).toHaveBeenCalledTimes(initialLoads);
      },
    );
  });
});
