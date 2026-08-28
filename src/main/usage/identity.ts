import { createHash } from 'node:crypto';
import type { ClaudeMetrics, ClaudePreset } from '../../shared/contracts';
import { isSubscriptionProvider } from '../../shared/claude/subscriptions';
import type { ClaudeLaunchConfigSnapshot } from '../claude/config-store';

export interface ModelUsageConnection {
  /** Main-only opaque account/endpoint identity; never sent over renderer IPC. */
  id: string;
  preset: ClaudePreset;
  model: string;
  mode: 'api' | 'subscription';
  epoch?: string;
}

export interface ModelUsageObserver {
  capture: (connection: ModelUsageConnection) => ModelUsageConnection;
  select: (connection: ModelUsageConnection | undefined, reset: boolean) => void;
  observe: (
    connection: ModelUsageConnection | undefined,
    cwd: string,
    sessionId: string | undefined,
    metrics?: ClaudeMetrics,
  ) => void;
}

export const modelUsageConnection = (
  snapshot: ClaudeLaunchConfigSnapshot,
): ModelUsageConnection => {
  const { config, storage } = snapshot;
  const preset = config.preset;
  return {
    id: createHash('sha256')
      .update(
        JSON.stringify([
          preset,
          storage.project?.sourceBaseUrl ?? config.baseUrl,
          snapshot.sourceCredential ?? snapshot.credential ?? '',
          storage.project?.sourceAuthMode ?? config.authMode,
        ]),
      )
      .digest('hex'),
    preset,
    model: storage.project?.sourceModel ?? config.model,
    mode:
      preset === 'anthropic' || preset === 'chatgpt-subscription' || isSubscriptionProvider(preset)
        ? 'subscription'
        : 'api',
  };
};
