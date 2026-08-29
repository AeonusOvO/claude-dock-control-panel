import { sanitizeAccountIdentity } from '../../../shared/claude/account-identity';
import type {
  ClaudeConfigView,
  ClaudeConnectionHistoryEntry,
  ClaudeNextConversationConnectionState,
  ClaudeProjectState,
} from '../../../shared/contracts';
import { requiredElement } from '../../platform/dom';
import {
  createCurrentConnectionSummary,
  redactConnectionEndpoint,
} from './current-connection-summary';
import type { ConnectionHistoryDependencies, ConnectionHistoryState } from './history-dependencies';

const currentConnection = requiredElement<HTMLElement>('#current-connection');
const currentConnectionName = requiredElement<HTMLElement>('#current-connection-name');
const currentConnectionType = requiredElement<HTMLElement>('#current-connection-type');
const currentConnectionMetadata = requiredElement<HTMLElement>('#current-connection-metadata');

const visibleBaseUrl = (config: ClaudeConfigView): string =>
  (config.sourceBaseUrl ?? config.baseUrl).trim();

const visibleModel = (config: ClaudeConfigView): string =>
  (config.sourceModel ?? config.model).trim();

const historyMatchesConfig = (
  entry: ClaudeConnectionHistoryEntry,
  config: ClaudeConfigView,
): boolean =>
  entry.preset === config.preset &&
  (entry.sourceBaseUrl ?? entry.baseUrl).trim() === visibleBaseUrl(config) &&
  (entry.sourceModel ?? entry.model).trim() === visibleModel(config) &&
  (entry.sourceAuthMode ?? entry.authMode) === (config.sourceAuthMode ?? config.authMode);

const matchingHistoryName = (
  entries: readonly ClaudeConnectionHistoryEntry[],
  config: ClaudeConfigView,
): string | undefined => entries.find((entry) => historyMatchesConfig(entry, config))?.name;

const renderEmpty = (): void => {
  currentConnection.dataset.kind = 'empty';
  delete currentConnection.dataset.connectionType;
  currentConnectionType.hidden = true;
  currentConnectionType.textContent = '';
  currentConnectionName.textContent = '尚未选择接入';
  currentConnectionMetadata.textContent =
    '请先选择平台和模型；保存后，下个新对话会立即捕获这套配置。';
};

type AccountReadStatus = 'failed' | 'loading' | 'ready';

interface AccountReadRequest {
  generation: number;
  promise: Promise<void>;
}

interface AccountReadCacheEntry {
  automaticRetryUsed?: boolean;
  identity?: string;
  lastReadAt?: number;
  readAttempted?: boolean;
  request?: AccountReadRequest;
  retryAfter?: number;
  retryOnNextRender?: boolean;
  status: AccountReadStatus;
  busyRetryCount?: number;
}

const accountConnectionKey = (config: ClaudeConfigView, accountIdentity?: string): string =>
  JSON.stringify([
    config.preset,
    config.provider,
    redactConnectionEndpoint(config.sourceBaseUrl) ??
      redactConnectionEndpoint(config.baseUrl) ??
      '',
    visibleModel(config),
    config.protocol,
    config.routerProviderId ?? '',
    config.sourceAuthMode ?? config.authMode,
    config.sourceCredentialConfigured ?? config.credentialConfigured,
    sanitizeAccountIdentity(accountIdentity) ?? '',
  ]);

const accountConnectionKeyForState = (
  state: ClaudeNextConversationConnectionState,
): string | undefined =>
  state.config
    ? accountConnectionKey(state.config, sanitizeAccountIdentity(state.accountIdentity))
    : undefined;

const ACCOUNT_READ_RETRY_DELAY_MS = 1_000;
const ACCOUNT_READ_BUSY_MAX_DELAY_MS = 30_000;
const ACCOUNT_READ_BUSY_MAX_RETRIES = 6;
const ACCOUNT_READ_REVALIDATE_INTERVAL_MS = 60_000;

export interface CurrentConnectionViewActions {
  dispose: () => void;
  invalidateManagedChatGptAccount: () => void;
  render: (projectState?: ClaudeProjectState) => void;
}

type AccountSummaryUpdater = (
  key: string,
  state: ClaudeNextConversationConnectionState | undefined,
  accountIdentity?: string,
  accountStatus?: 'failed' | 'loading',
) => void;

interface ManagedChatGptAccountReadInput {
  applySummary: AccountSummaryUpdater;
  clearForcedRead: () => void;
  dependencies: Pick<
    ConnectionHistoryDependencies,
    'getManagedChatGptGatewayState' | 'nextClaudeConnection'
  >;
  entry: AccountReadCacheEntry;
  isCurrent: (key: string, requestGeneration: number) => boolean;
  key: string;
  requestGeneration: number;
  scheduleAccountRetry: (delay?: number) => void;
}

const readManagedChatGptAccount = ({
  applySummary,
  clearForcedRead,
  dependencies,
  entry,
  isCurrent,
  key,
  requestGeneration,
  scheduleAccountRetry,
}: ManagedChatGptAccountReadInput): Promise<void> => {
  const promise = Promise.resolve()
    .then(() => dependencies.getManagedChatGptGatewayState())
    .then((managedState) => {
      if (!isCurrent(key, requestGeneration)) return;
      if (managedState.busy) {
        const busyRetryCount = (entry.busyRetryCount ?? 0) + 1;
        entry.busyRetryCount = busyRetryCount;
        if (busyRetryCount >= ACCOUNT_READ_BUSY_MAX_RETRIES) {
          entry.identity = undefined;
          entry.lastReadAt = undefined;
          entry.retryAfter = undefined;
          entry.retryOnNextRender = false;
          entry.status = 'failed';
          clearForcedRead();
        } else {
          const retryDelay = Math.min(
            ACCOUNT_READ_RETRY_DELAY_MS * 2 ** Math.min(busyRetryCount - 1, 5),
            ACCOUNT_READ_BUSY_MAX_DELAY_MS,
          );
          entry.retryAfter = Date.now() + retryDelay;
          entry.retryOnNextRender = true;
          scheduleAccountRetry(retryDelay);
          entry.status = 'loading';
        }
        applySummary(
          key,
          dependencies.nextClaudeConnection(),
          entry.identity ?? '',
          entry.status === 'failed' ? 'failed' : 'loading',
        );
        return;
      }
      const identity = sanitizeAccountIdentity(managedState.accountEmail);
      entry.automaticRetryUsed = false;
      entry.busyRetryCount = 0;
      entry.lastReadAt = Date.now();
      entry.identity = identity;
      entry.retryAfter = undefined;
      entry.retryOnNextRender = false;
      entry.status = 'ready';
      clearForcedRead();
      scheduleAccountRetry(ACCOUNT_READ_REVALIDATE_INTERVAL_MS);
      applySummary(key, dependencies.nextClaudeConnection(), identity ?? '');
    })
    .catch(() => {
      if (!isCurrent(key, requestGeneration)) return;
      const canRetry = entry.automaticRetryUsed !== true;
      entry.automaticRetryUsed = true;
      entry.busyRetryCount = 0;
      entry.retryAfter = canRetry ? Date.now() + ACCOUNT_READ_RETRY_DELAY_MS : undefined;
      entry.retryOnNextRender = canRetry;
      if (!canRetry) {
        entry.identity = undefined;
        entry.lastReadAt = undefined;
        clearForcedRead();
      }
      if (canRetry) scheduleAccountRetry();
      entry.status = 'failed';
      applySummary(
        key,
        dependencies.nextClaudeConnection(),
        entry.identity ?? '',
        entry.identity ? undefined : 'failed',
      );
    })
    .finally(() => {
      if (entry.request?.promise === promise) entry.request = undefined;
    });
  return promise;
};

/** Renders connection truth while retaining safe account reads across unrelated runtime updates. */
export const createCurrentConnectionViewActions = (
  dependencies: Pick<
    ConnectionHistoryDependencies,
    'getManagedChatGptGatewayState' | 'nextClaudeConnection'
  >,
  historyState: ConnectionHistoryState,
): CurrentConnectionViewActions => {
  let activeKey: string | undefined;
  let disposed = false;
  let forceManagedChatGptRead = false;
  let generation = 0;
  let retryTimer: number | undefined;
  const accountCache = new Map<string, AccountReadCacheEntry>();

  const applySummary = (
    nextConnection: ClaudeNextConversationConnectionState,
    accountIdentity?: string,
    accountStatus?: 'failed' | 'loading',
  ): void => {
    if (!nextConnection.config) {
      renderEmpty();
      return;
    }
    const summary = createCurrentConnectionSummary(nextConnection.config, {
      accountIdentity: accountIdentity ?? nextConnection.accountIdentity,
      accountStatus,
      connectionName: matchingHistoryName(historyState.allEntries, nextConnection.config),
      officialAuth: nextConnection.officialAuth,
    });
    currentConnection.dataset.kind = summary.kind;
    currentConnection.dataset.connectionType = summary.connectionType;
    currentConnectionType.hidden = false;
    currentConnectionType.textContent = summary.connectionType === 'subscription' ? '订阅' : 'API';
    currentConnectionName.textContent = summary.name;
    currentConnectionMetadata.textContent = summary.metadata.join(' · ');
  };

  const applyActiveSummary = (
    key: string,
    state: ClaudeNextConversationConnectionState | undefined,
    accountIdentity?: string,
    accountStatus?: 'failed' | 'loading',
  ): void => {
    if (state?.config && accountConnectionKeyForState(state) === key)
      applySummary(state, accountIdentity, accountStatus);
  };

  const isCurrent = (key: string, requestGeneration: number): boolean =>
    !disposed && key === activeKey && requestGeneration === generation;

  const scheduleAccountRetry = (delay = ACCOUNT_READ_RETRY_DELAY_MS): void => {
    if (disposed || retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      if (!disposed) render();
    }, delay);
  };

  const clearAccountRetry = (): void => {
    if (retryTimer === undefined) return;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const render = (_projectState?: ClaudeProjectState): void => {
    if (disposed) return;
    const nextConnection = dependencies.nextClaudeConnection() ?? {};
    if (!nextConnection.config) {
      clearAccountRetry();
      if (activeKey !== undefined) {
        activeKey = undefined;
        generation += 1;
      }
      renderEmpty();
      return;
    }

    const suppliedIdentity = sanitizeAccountIdentity(nextConnection.accountIdentity);
    const key = accountConnectionKeyForState(nextConnection)!;
    if (key !== activeKey) {
      activeKey = key;
      generation += 1;
      clearAccountRetry();
    }

    if (nextConnection.config.preset !== 'chatgpt-subscription') {
      applySummary(nextConnection);
      return;
    }

    const entry = accountCache.get(key) ?? { status: 'loading' as const };
    accountCache.set(key, entry);
    if (forceManagedChatGptRead) {
      entry.identity = undefined;
      entry.lastReadAt = undefined;
      entry.status = 'loading';
    } else if (suppliedIdentity && !entry.readAttempted && entry.identity !== suppliedIdentity) {
      entry.identity = suppliedIdentity;
      entry.lastReadAt = Date.now();
      entry.status = 'ready';
    }

    const requestGeneration = generation;
    const cachedIdentity = entry.readAttempted ? (entry.identity ?? '') : entry.identity;
    if (cachedIdentity) {
      applySummary(nextConnection, cachedIdentity);
    } else if (entry.status === 'failed') {
      applySummary(nextConnection, cachedIdentity, 'failed');
    } else if (entry.status === 'ready') {
      applySummary(nextConnection, cachedIdentity);
    } else {
      entry.status = 'loading';
      applySummary(nextConnection, cachedIdentity, 'loading');
    }

    const request = entry.request;
    if (request && request.generation === requestGeneration) {
      return;
    }
    if (entry.retryAfter !== undefined) {
      if (Date.now() < entry.retryAfter) {
        scheduleAccountRetry(Math.max(0, entry.retryAfter - Date.now()));
        return;
      }
      entry.retryAfter = undefined;
    }
    if (entry.status === 'ready' && entry.lastReadAt !== undefined) {
      const revalidateIn = ACCOUNT_READ_REVALIDATE_INTERVAL_MS - (Date.now() - entry.lastReadAt);
      if (revalidateIn > 0) {
        scheduleAccountRetry(revalidateIn);
        return;
      }
    }
    if (entry.status === 'failed' && !entry.retryOnNextRender && !request) return;
    if (entry.status === 'failed') entry.retryOnNextRender = false;

    entry.readAttempted = true;
    const promise = readManagedChatGptAccount({
      applySummary: applyActiveSummary,
      clearForcedRead: () => {
        forceManagedChatGptRead = false;
      },
      dependencies,
      entry,
      isCurrent,
      key,
      requestGeneration,
      scheduleAccountRetry,
    });
    entry.request = { generation: requestGeneration, promise };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    generation += 1;
    accountCache.clear();
    activeKey = undefined;
  };

  const invalidateManagedChatGptAccount = (): void => {
    if (disposed) return;
    if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    generation += 1;
    accountCache.clear();
    activeKey = undefined;
    forceManagedChatGptRead = true;
    render();
  };

  return { dispose, invalidateManagedChatGptAccount, render };
};
