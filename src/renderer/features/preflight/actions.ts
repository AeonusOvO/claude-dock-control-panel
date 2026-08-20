import type {
  ClaudeProvider,
  DevelopmentRuntime,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../../shared/contracts';
import type { PreflightElements } from './elements';
import type { PreflightState } from './state';
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
  runActiveNetworkPreflight: (
    force: boolean,
    providerOverride?: NetworkProviderId,
  ) => Promise<void>;
}

interface PreflightActionsContext {
  dependencies: PreflightActionsDependencies;
  elements: PreflightElements;
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

const runActiveNetworkPreflight = async (
  context: PreflightActionsContext,
  force: boolean,
  providerOverride?: NetworkProviderId,
): Promise<void> => {
  const { dependencies, elements, state, view } = context;
  const provider = providerOverride ?? activeNetworkProvider(context);
  if (!provider || state.networkPreflightInProgress) {
    if (!provider && force) {
      dependencies.showToast('当前 Claude 配置使用自定义网关，不需要官方服务预检。');
    }
    return;
  }
  state.networkPreflightInProgress = true;
  elements.networkPreflightRecheck.disabled = true;
  elements.networkPreflightDialogRecheck.disabled = true;
  try {
    const result = await window.controlPanel.runNetworkPreflight({
      action: 'background',
      force,
      provider,
    });
    state.networkPreflightResults.set(provider, result);
    view.renderActiveNetworkPreflight();
    if (
      !state.networkPreflightDialogProvider ||
      state.networkPreflightDialogProvider === provider
    ) {
      view.renderNetworkPreflightDetails(result);
    }
  } catch (error) {
    dependencies.showToast(error instanceof Error ? error.message : '网络预检无法完成。', 'error');
  } finally {
    state.networkPreflightInProgress = false;
    elements.networkPreflightDialogRecheck.disabled = false;
    view.renderActiveNetworkPreflight();
  }
};

const openNetworkPreflightDialog = async (
  context: PreflightActionsContext,
  providerOverride?: NetworkProviderId,
): Promise<void> => {
  const { elements, state, view } = context;
  const provider = providerOverride ?? activeNetworkProvider(context);
  state.networkPreflightDialogProvider = provider;
  view.renderNetworkPreflightDetails(
    provider ? state.networkPreflightResults.get(provider) : undefined,
  );
  if (!elements.networkPreflightDialog.open) {
    elements.networkPreflightDialog.showModal();
  }
};

const invalidateAndRun = async (
  context: PreflightActionsContext,
  reason: string,
  force = true,
): Promise<void> => {
  await window.controlPanel.invalidateNetworkPreflight(reason);
  void runActiveNetworkPreflight(context, force);
};

const handleNetworkPreflight = (
  context: PreflightActionsContext,
  result: NetworkPreflightResult,
): void => {
  const { dependencies, elements, state, view } = context;
  state.networkPreflightResults.set(result.provider, result);
  if (result.provider === activeNetworkProvider(context)) {
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
  } else if (result.status === 'blocked') {
    state.networkPreflightDialogProvider = result.provider;
    view.renderNetworkPreflightDetails(result);
    if (!elements.networkPreflightDialog.open) {
      elements.networkPreflightDialog.showModal();
    }
  }
};

const bindPreflightActions = (context: PreflightActionsContext): (() => void) => {
  const { dependencies, elements, state } = context;
  const unsubscribeNetworkPreflight = window.controlPanel.onNetworkPreflight((result) => {
    handleNetworkPreflight(context, result);
  });
  const handleDetails = (): void => void openNetworkPreflightDialog(context);
  const handleRecheck = (): void => void runActiveNetworkPreflight(context, true);
  const handleDialogRecheck = (): void =>
    void runActiveNetworkPreflight(context, true, state.networkPreflightDialogProvider);
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
      connection?: EventTarget;
    }
  ).connection;

  elements.networkPreflightDetails.addEventListener('click', handleDetails);
  elements.networkPreflightRecheck.addEventListener('click', handleRecheck);
  elements.networkPreflightDialogRecheck.addEventListener('click', handleDialogRecheck);
  elements.networkPreflightClose.addEventListener('click', handleClose);
  elements.networkPreflightClearHistory.addEventListener('click', handleClearHistory);
  window.addEventListener('online', handleNetworkEnvironmentChange);
  window.addEventListener('offline', handleNetworkEnvironmentChange);
  networkInformation?.addEventListener('change', handleNetworkEnvironmentChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    unsubscribeNetworkPreflight();
    elements.networkPreflightDetails.removeEventListener('click', handleDetails);
    elements.networkPreflightRecheck.removeEventListener('click', handleRecheck);
    elements.networkPreflightDialogRecheck.removeEventListener('click', handleDialogRecheck);
    elements.networkPreflightClose.removeEventListener('click', handleClose);
    elements.networkPreflightClearHistory.removeEventListener('click', handleClearHistory);
    window.removeEventListener('online', handleNetworkEnvironmentChange);
    window.removeEventListener('offline', handleNetworkEnvironmentChange);
    networkInformation?.removeEventListener('change', handleNetworkEnvironmentChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
};

export const createPreflightActions = (
  elements: PreflightElements,
  state: PreflightState,
  dependencies: PreflightActionsDependencies,
  view: PreflightView,
): PreflightActions => {
  const context = { dependencies, elements, state, view };
  return {
    activeNetworkProvider: () => activeNetworkProvider(context),
    bind: () => bindPreflightActions(context),
    invalidateAndRun: (reason, force) => invalidateAndRun(context, reason, force),
    openNetworkPreflightDialog: (providerOverride) =>
      openNetworkPreflightDialog(context, providerOverride),
    runActiveNetworkPreflight: (force, providerOverride) =>
      runActiveNetworkPreflight(context, force, providerOverride),
  };
};
