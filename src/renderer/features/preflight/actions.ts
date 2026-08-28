import type {
  ClaudeProvider,
  DevelopmentRuntime,
  NetworkPreflightPreferences,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../../shared/contracts';
import { automaticNetworkPreflightEnabled } from '../../../shared/network-preflight-policy';
import type { PreflightElements } from './elements';
import {
  acceptBackgroundApplicationResult,
  clearTestingBackgroundResults,
  ownsPreflightOperation,
  type PreflightOperationToken,
  type PreflightState,
} from './state';
import type { PreflightView } from './view';

export interface PreflightActionsDependencies {
  getActiveClaudeProvider: () => ClaudeProvider | undefined;
  getActiveDevelopmentRuntime: () => DevelopmentRuntime;
  refreshActiveRuntimeAfterPreflight: () => boolean;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface PreflightActions {
  activeNetworkProvider: () => NetworkProviderId | undefined;
  bind: () => () => void;
  invalidateAndRun: (reason: string, force?: boolean) => Promise<void>;
  openNetworkPreflightDialog: (providerOverride?: NetworkProviderId) => Promise<void>;
  refreshAfterAuthoritativeChange: () => Promise<void>;
  runActiveNetworkPreflight: (
    force: boolean,
    providerOverride?: NetworkProviderId,
  ) => Promise<void>;
  setPreferences: (preferences: NetworkPreflightPreferences) => void;
}

interface PreflightRunRequest {
  force: boolean;
  manual: boolean;
  provider: NetworkProviderId;
}

interface ActivePreflightRun {
  operation: PreflightOperationToken;
  promise: Promise<void>;
  request: PreflightRunRequest;
}

interface QueuedPreflightRun {
  request: PreflightRunRequest;
  waiters: Array<() => void>;
}

interface PreflightActionsContext {
  activeRun?: ActivePreflightRun;
  dependencies: PreflightActionsDependencies;
  elements: PreflightElements;
  nextOperationSequence: number;
  queuedRun?: QueuedPreflightRun;
  state: PreflightState;
  view: PreflightView;
}

const activeNetworkProvider = (context: PreflightActionsContext): NetworkProviderId | undefined => {
  const { dependencies } = context;
  if (dependencies.getActiveDevelopmentRuntime() === 'codex') {
    return 'openai-codex';
  }
  const provider = dependencies.getActiveClaudeProvider();
  // Do not guess "official Anthropic" while the project configuration is still loading. That
  // guess used to start an official-network preflight which could later disable a gateway-backed
  // Claude launch button, even after the saved gateway configuration had rendered successfully.
  if (!provider) return undefined;
  return provider === 'gateway' ? undefined : 'anthropic-claude';
};

const manualNetworkProvider = (
  _context: PreflightActionsContext,
  providerOverride?: NetworkProviderId,
): NetworkProviderId => providerOverride ?? 'ai-services';

const renderPreflightPresentation = (
  context: PreflightActionsContext,
  provider: NetworkProviderId,
): void => {
  context.view.renderActiveNetworkPreflight();
  if (context.elements.networkPreflightDialog.open) {
    const dialogProvider = context.state.networkPreflightDialogProvider ?? provider;
    context.view.renderNetworkPreflightDetails(
      context.state.networkPreflightResults.get(dialogProvider),
    );
  }
};

const startNetworkPreflightRun = (
  context: PreflightActionsContext,
  request: PreflightRunRequest,
): Promise<void> => {
  const { dependencies, state } = context;
  const operation = Object.freeze({
    action: 'background' as const,
    manual: request.manual,
    provider: request.provider,
    sequence: context.nextOperationSequence++,
  });
  state.networkPreflightOperation = operation;
  renderPreflightPresentation(context, request.provider);
  const promise = (async () => {
    try {
      const result = await window.controlPanel.runNetworkPreflight({
        action: operation.action,
        force: request.force,
        provider: request.provider,
      });
      if (!ownsPreflightOperation(state, operation)) return;
      if (acceptBackgroundApplicationResult(state, result)) {
        renderPreflightPresentation(context, request.provider);
      }
    } catch (error) {
      if (ownsPreflightOperation(state, operation) && !context.queuedRun) {
        dependencies.showToast(
          error instanceof Error ? error.message : '网络预检无法完成。',
          'error',
        );
      }
    }
  })().finally(() => {
    if (context.activeRun?.operation !== operation || !ownsPreflightOperation(state, operation)) {
      return;
    }
    context.activeRun = undefined;
    const queued = context.queuedRun;
    context.queuedRun = undefined;
    if (queued) {
      const next = startNetworkPreflightRun(context, queued.request);
      void next.then(() => {
        for (const resolve of queued.waiters) resolve();
      });
      return;
    }
    state.networkPreflightOperation = undefined;
    renderPreflightPresentation(context, request.provider);
  });
  context.activeRun = { operation, promise, request };
  return promise;
};

const queueNetworkPreflightRun = (
  context: PreflightActionsContext,
  request: PreflightRunRequest,
  supersedeActive: boolean,
): Promise<void> => {
  const active = context.activeRun;
  if (!active) {
    return startNetworkPreflightRun(context, request);
  }
  if (supersedeActive) {
    const queued = context.queuedRun;
    context.queuedRun = undefined;
    for (const resolve of queued?.waiters ?? []) resolve();
    return startNetworkPreflightRun(context, request);
  }
  if (active.request.provider === request.provider && (active.request.force || !request.force)) {
    return active.promise;
  }
  return new Promise((resolve) => {
    const queued = context.queuedRun;
    if (queued) {
      queued.request =
        queued.request.provider === request.provider
          ? {
              force: queued.request.force || request.force,
              manual: queued.request.manual || request.manual,
              provider: request.provider,
            }
          : request;
      queued.waiters.push(resolve);
      return;
    }
    context.queuedRun = { request, waiters: [resolve] };
  });
};

const runActiveNetworkPreflight = (
  context: PreflightActionsContext,
  force: boolean,
  providerOverride?: NetworkProviderId,
  supersedeActive = false,
): Promise<void> => {
  if (!automaticNetworkPreflightEnabled(context.state.networkPreflightPreferences, 'background')) {
    return Promise.resolve();
  }
  const provider = providerOverride ?? activeNetworkProvider(context);
  if (!provider) {
    if (force) {
      context.dependencies.showToast('当前 Claude 配置使用自定义网关，不需要官方服务预检。');
    }
    return Promise.resolve();
  }
  return queueNetworkPreflightRun(context, { force, manual: false, provider }, supersedeActive);
};

const runManualNetworkPreflight = (
  context: PreflightActionsContext,
  providerOverride?: NetworkProviderId,
): Promise<void> => {
  const provider = manualNetworkProvider(context, providerOverride);
  context.state.networkPreflightDisplayProvider = provider;
  return queueNetworkPreflightRun(context, { force: true, manual: true, provider }, true);
};

const openNetworkPreflightDialog = async (
  context: PreflightActionsContext,
  providerOverride?: NetworkProviderId,
): Promise<void> => {
  const { elements, state, view } = context;
  const provider = manualNetworkProvider(context, providerOverride);
  state.networkPreflightDisplayProvider = provider;
  state.networkPreflightDialogProvider = provider;
  view.renderNetworkPreflightDetails(state.networkPreflightResults.get(provider));
  if (!elements.networkPreflightDialog.open) {
    elements.networkPreflightDialog.showModal();
  }
};

const refreshAfterAuthoritativeChange = (
  context: PreflightActionsContext,
  force = true,
): Promise<void> => {
  if (clearTestingBackgroundResults(context.state)) {
    context.view.renderActiveNetworkPreflight();
  }
  return runActiveNetworkPreflight(context, force, undefined, true);
};

const invalidateAndRun = async (
  context: PreflightActionsContext,
  reason: string,
  force = true,
): Promise<void> => {
  await window.controlPanel.invalidateNetworkPreflight(reason);
  return refreshAfterAuthoritativeChange(context, force);
};

const invalidateAndRunManual = async (
  context: PreflightActionsContext,
  reason: string,
  providerOverride?: NetworkProviderId,
): Promise<void> => {
  await window.controlPanel.invalidateNetworkPreflight(reason);
  return runManualNetworkPreflight(context, providerOverride);
};

const hasPausedClaudeLaunchDialog = (): boolean =>
  document.querySelector<HTMLDialogElement>('#claude-launch-preflight-dialog')?.open === true;

const handleNetworkPreflight = (
  context: PreflightActionsContext,
  result: NetworkPreflightResult,
): void => {
  const { dependencies, elements, state, view } = context;
  if (
    !automaticNetworkPreflightEnabled(state.networkPreflightPreferences, 'background') &&
    !state.networkPreflightOperation?.manual
  ) {
    return;
  }
  if (!acceptBackgroundApplicationResult(state, result)) return;
  const displayedProvider = activeNetworkProvider(context) ?? state.networkPreflightDisplayProvider;
  if (result.provider === displayedProvider) {
    if (!dependencies.refreshActiveRuntimeAfterPreflight()) {
      view.renderActiveNetworkPreflight();
    }
    if (
      elements.networkPreflightDialog.open &&
      (!state.networkPreflightDialogProvider ||
        state.networkPreflightDialogProvider === result.provider)
    ) {
      view.renderNetworkPreflightDetails(result);
    }
  } else if (result.providerConnectivity.status === 'blocked' && !state.networkPreflightOperation) {
    state.networkPreflightDialogProvider = result.provider;
    view.renderNetworkPreflightDetails(result);
    if (!elements.networkPreflightDialog.open && !hasPausedClaudeLaunchDialog()) {
      elements.networkPreflightDialog.showModal();
    }
  }
};

const setPreferences = (
  context: PreflightActionsContext,
  preferences: NetworkPreflightPreferences,
): void => {
  context.state.networkPreflightPreferences = { ...preferences };
  if (!automaticNetworkPreflightEnabled(preferences, 'background')) {
    const queued = context.queuedRun;
    if (queued && !queued.request.manual) {
      context.queuedRun = undefined;
      for (const resolve of queued.waiters) resolve();
    }
    const active = context.activeRun;
    if (active && !active.request.manual) {
      // Detach only presentation ownership. Do not invalidate the main route or interrupt a login,
      // terminal or explicit manual diagnostic that may be using the same network configuration.
      context.activeRun = undefined;
      if (ownsPreflightOperation(context.state, active.operation)) {
        context.state.networkPreflightOperation = undefined;
      }
    }
    clearTestingBackgroundResults(context.state);
  }
  if (!context.dependencies.refreshActiveRuntimeAfterPreflight()) {
    context.view.renderActiveNetworkPreflight();
  }
};

const bindPreflightActions = (context: PreflightActionsContext): (() => void) => {
  const { dependencies, elements, state } = context;
  const unsubscribeNetworkPreflight = window.controlPanel.onNetworkPreflight((result) => {
    handleNetworkPreflight(context, result);
  });
  const handleDetails = (): void => void openNetworkPreflightDialog(context);
  const handleManualDetails = (): void => {
    const provider = manualNetworkProvider(context);
    void openNetworkPreflightDialog(context, provider);
    void runManualNetworkPreflight(context, provider);
  };
  const handleRecheck = (): void => void runManualNetworkPreflight(context);
  const handleRepair = (event: Event): void => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      '[data-network-repair]',
    );
    if (!button?.dataset.value) return;
    const kind = button.dataset.networkRepair;
    if (kind !== 'timezone') return;
    button.disabled = true;
    void window.controlPanel
      .getAppSettings()
      .then((settings) =>
        window.controlPanel.setAdvancedSettings({
          ...settings.advanced,
          networkPreflight: {
            ...settings.advanced.networkPreflight,
            cliTimezone: button.dataset.value,
          },
        }),
      )
      .then((settings) => {
        window.dispatchEvent(
          new CustomEvent('claudedock:network-preferences-updated', {
            detail: settings.advanced.networkPreflight,
          }),
        );
        dependencies.showToast('已保存为 ClaudeDock CLI 设置；重开会话后生效。');
        return invalidateAndRunManual(
          context,
          'network-process-environment-updated',
          state.networkPreflightDialogProvider ?? state.networkPreflightDisplayProvider,
        );
      })
      .catch(() => {
        dependencies.showToast('无法保存 CLI 环境设置。', 'error');
      })
      .finally(() => {
        button.disabled = false;
      });
  };
  const handleDialogRecheck = (): void =>
    void runManualNetworkPreflight(context, state.networkPreflightDialogProvider);
  const handleClose = (): void => elements.networkPreflightDialog.close();
  const handleClearHistory = (): void => {
    elements.networkPreflightClearHistory.disabled = true;
    void window.controlPanel
      .clearNetworkPreflightHistory()
      .then(() => {
        dependencies.showToast('网络诊断历史已清除。');
      })
      .catch(() => {
        dependencies.showToast('无法清除网络诊断历史。', 'error');
      })
      .finally(() => {
        elements.networkPreflightClearHistory.disabled = false;
      });
  };
  const handleNetworkEnvironmentChange = (): void => {
    void invalidateAndRun(context, 'network-environment-changed').catch(() => {
      dependencies.showToast('网络环境已变化，但自动复检无法启动。', 'error');
    });
  };
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void runActiveNetworkPreflight(context, false);
    }
  };
  const networkInformation = (
    navigator as Navigator & {
      connection?: EventTarget & { type?: string };
    }
  ).connection;
  let connectionType = networkInformation?.type;
  const handleConnectionChange = (): void => {
    const previousType = connectionType;
    connectionType = networkInformation?.type;
    // Chromium also emits `change` for rolling RTT/downlink/effectiveType estimates. Probing the
    // network changes those estimates itself; invalidating here used to cancel every waiting launch.
    // Only a known transport change is authoritative. Online/offline and saved proxy changes retain
    // their own invalidation paths, and launch probes still require current route leases.
    if (previousType && connectionType && previousType !== connectionType) {
      handleNetworkEnvironmentChange();
    }
  };

  elements.networkPreflightDetails.addEventListener('click', handleDetails);
  elements.networkPreflightTrigger.addEventListener('click', handleManualDetails);
  elements.networkPreflightRecheck.addEventListener('click', handleRecheck);
  elements.settingsNetworkRecheck.addEventListener('click', handleRecheck);
  elements.settingsNetworkIssues.addEventListener('click', handleRepair);
  elements.networkPreflightEnvironment.addEventListener('click', handleRepair);
  elements.networkPreflightDialogRecheck.addEventListener('click', handleDialogRecheck);
  elements.networkPreflightClose.addEventListener('click', handleClose);
  elements.networkPreflightClearHistory.addEventListener('click', handleClearHistory);
  window.addEventListener('online', handleNetworkEnvironmentChange);
  window.addEventListener('offline', handleNetworkEnvironmentChange);
  networkInformation?.addEventListener('change', handleConnectionChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    unsubscribeNetworkPreflight();
    elements.networkPreflightDetails.removeEventListener('click', handleDetails);
    elements.networkPreflightTrigger.removeEventListener('click', handleManualDetails);
    elements.networkPreflightRecheck.removeEventListener('click', handleRecheck);
    elements.settingsNetworkRecheck.removeEventListener('click', handleRecheck);
    elements.settingsNetworkIssues.removeEventListener('click', handleRepair);
    elements.networkPreflightEnvironment.removeEventListener('click', handleRepair);
    elements.networkPreflightDialogRecheck.removeEventListener('click', handleDialogRecheck);
    elements.networkPreflightClose.removeEventListener('click', handleClose);
    elements.networkPreflightClearHistory.removeEventListener('click', handleClearHistory);
    window.removeEventListener('online', handleNetworkEnvironmentChange);
    window.removeEventListener('offline', handleNetworkEnvironmentChange);
    networkInformation?.removeEventListener('change', handleConnectionChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
};

export const createPreflightActions = (
  elements: PreflightElements,
  state: PreflightState,
  dependencies: PreflightActionsDependencies,
  view: PreflightView,
): PreflightActions => {
  const context = { dependencies, elements, nextOperationSequence: 1, state, view };
  return {
    activeNetworkProvider: () => activeNetworkProvider(context),
    bind: () => bindPreflightActions(context),
    invalidateAndRun: (reason, force) => invalidateAndRun(context, reason, force),
    openNetworkPreflightDialog: (providerOverride) =>
      openNetworkPreflightDialog(context, providerOverride),
    refreshAfterAuthoritativeChange: () => refreshAfterAuthoritativeChange(context),
    runActiveNetworkPreflight: (force, providerOverride) =>
      runActiveNetworkPreflight(context, force, providerOverride),
    setPreferences: (preferences) => setPreferences(context, preferences),
  };
};
