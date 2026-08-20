import type { SaveApplicationProxyInput } from '../../../shared/contracts';
import type { ProxyElements } from './elements';
import type { ProxyState } from './state';
import type { ProxyView } from './view';

export interface ProxyActionsDependencies {
  invalidatePreflight: () => Promise<void>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  updateSettingsUnsavedIndicator: () => void;
}

export interface ProxyActions {
  beginDialogLoad: () => number;
  bind: () => () => void;
  completeDialogLoad: (loadGeneration: number, loaded: boolean) => boolean;
  endDialogSession: (restore: boolean) => void;
  loadState: (preserveDirtyDraft?: boolean, loadGeneration?: number) => Promise<boolean>;
  savePending: () => Promise<boolean>;
}

interface ProxyActionsContext {
  dependencies: ProxyActionsDependencies;
  elements: ProxyElements;
  state: ProxyState;
  view: ProxyView;
}

const beginDialogLoad = (context: ProxyActionsContext): number => {
  const { state, view } = context;
  state.cancelBaseline = view.captureDraft();
  const loadGeneration = ++state.loadGeneration;
  state.initialLoadPending = true;
  state.draftEdited = false;
  view.syncInteractivity();
  return loadGeneration;
};

const completeDialogLoad = (
  context: ProxyActionsContext,
  loadGeneration: number,
  loaded: boolean,
): boolean => {
  const { state, view } = context;
  if (loadGeneration !== state.loadGeneration) return false;
  state.initialLoadPending = false;
  if (loaded) state.cancelBaseline = view.captureDraft();
  view.syncInteractivity();
  return true;
};

const endDialogSession = (context: ProxyActionsContext, restore: boolean): void => {
  const { state, view } = context;
  if (restore && state.cancelBaseline) {
    view.applyDraft(state.cancelBaseline);
  }
  state.cancelBaseline = undefined;
  state.loadGeneration += 1;
  state.initialLoadPending = false;
  state.draftEdited = false;
};

const loadApplicationProxyState = async (
  context: ProxyActionsContext,
  preserveDirtyDraft = true,
  loadGeneration = context.state.loadGeneration,
): Promise<boolean> => {
  const { dependencies, view } = context;
  try {
    const proxyState = await window.controlPanel.getApplicationProxyState();
    if (loadGeneration !== context.state.loadGeneration) return false;
    view.renderState(proxyState, preserveDirtyDraft);
    return true;
  } catch {
    if (loadGeneration === context.state.loadGeneration) {
      dependencies.showToast('无法读取应用代理设置。', 'error');
    }
    return false;
  }
};

const pendingApplicationProxyInput = (elements: ProxyElements): SaveApplicationProxyInput => {
  const port = Number.parseInt(elements.port.value, 10);
  return {
    enabled: elements.enabled.checked,
    host: elements.host.value,
    password: elements.password.value || undefined,
    port: Number.isInteger(port) ? port : undefined,
    protocol: elements.protocol.value === 'socks5' ? 'socks5' : 'http',
    scope: {
      application: elements.scopeApplication.checked,
      cli: elements.scopeCli.checked,
      conversation: elements.scopeConversation.checked,
    },
    username: elements.username.value,
  };
};

const savePendingApplicationProxy = async (context: ProxyActionsContext): Promise<boolean> => {
  const { dependencies, elements, state, view } = context;
  if (!view.isDirty() || state.saveInProgress) return false;
  state.saveInProgress = true;
  elements.save.disabled = true;
  try {
    const proxyState = await window.controlPanel.saveApplicationProxy(
      pendingApplicationProxyInput(elements),
    );
    view.renderState(proxyState, false);
    state.draftEdited = false;
    state.cancelBaseline = view.captureDraft();
    await dependencies.invalidatePreflight();
    return true;
  } finally {
    state.saveInProgress = false;
    elements.save.disabled = false;
  }
};

const bindProxyActions = (context: ProxyActionsContext): (() => void) => {
  const { dependencies, elements, state, view } = context;
  const handleEnabledChange = (): void => {
    state.draftEdited = true;
    view.syncInteractivity();
    dependencies.updateSettingsUnsavedIndicator();
  };
  const handleProtocolChange = (): void => {
    state.draftEdited = true;
    view.syncInteractivity();
    dependencies.updateSettingsUnsavedIndicator();
  };
  const handleDraftInput = (): void => {
    state.draftEdited = true;
    view.syncInteractivity();
    dependencies.updateSettingsUnsavedIndicator();
  };
  const handleScopeChange = (): void => {
    state.draftEdited = true;
    view.syncInteractivity();
    dependencies.updateSettingsUnsavedIndicator();
  };
  const handleSaveClick = (): void => {
    void savePendingApplicationProxy(context)
      .then((saved) => {
        if (saved) dependencies.showToast('应用代理设置已保存');
      })
      .catch((error: unknown) => {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法保存应用代理设置。',
          'error',
        );
      });
  };
  const handleDetectClick = (): void => {
    elements.detect.disabled = true;
    void window.controlPanel
      .detectApplicationProxyCandidates()
      .then((candidates) => {
        view.renderCandidates(candidates);
        if (candidates.length === 0) dependencies.showToast('没有检测到系统或环境变量代理');
      })
      .catch(() => dependencies.showToast('无法检测现有代理。', 'error'))
      .finally(() => {
        elements.detect.disabled = false;
      });
  };
  const handleTestClick = (): void => {
    state.testInProgress = true;
    view.syncInteractivity();
    elements.test.textContent = '正在测试…';
    void window.controlPanel
      .testApplicationProxy()
      .then((proxyState) => {
        view.renderState(proxyState);
        dependencies.showToast(
          proxyState.test?.message ?? '代理测试完成',
          proxyState.test?.ok ? 'success' : 'error',
        );
      })
      .catch((error: unknown) => {
        dependencies.showToast(
          error instanceof Error ? error.message : '应用代理测试失败。',
          'error',
        );
      })
      .finally(() => {
        state.testInProgress = false;
        elements.test.textContent = '测试 GitHub 连接';
        view.syncInteractivity();
      });
  };

  for (const control of [elements.host, elements.port, elements.username, elements.password]) {
    control.addEventListener('input', handleDraftInput);
  }
  for (const control of [
    elements.scopeCli,
    elements.scopeApplication,
    elements.scopeConversation,
  ]) {
    control.addEventListener('change', handleScopeChange);
  }
  elements.enabled.addEventListener('change', handleEnabledChange);
  elements.protocol.addEventListener('change', handleProtocolChange);
  elements.save.addEventListener('click', handleSaveClick);
  elements.detect.addEventListener('click', handleDetectClick);
  elements.test.addEventListener('click', handleTestClick);

  const unsubscribeApplicationProxyChanged = window.controlPanel.onApplicationProxyChanged(
    (proxyState) => {
      view.renderState(proxyState);
    },
  );

  return () => {
    for (const control of [elements.host, elements.port, elements.username, elements.password]) {
      control.removeEventListener('input', handleDraftInput);
    }
    for (const control of [
      elements.scopeCli,
      elements.scopeApplication,
      elements.scopeConversation,
    ]) {
      control.removeEventListener('change', handleScopeChange);
    }
    elements.enabled.removeEventListener('change', handleEnabledChange);
    elements.protocol.removeEventListener('change', handleProtocolChange);
    elements.save.removeEventListener('click', handleSaveClick);
    elements.detect.removeEventListener('click', handleDetectClick);
    elements.test.removeEventListener('click', handleTestClick);
    unsubscribeApplicationProxyChanged();
  };
};

export const createProxyActions = (
  elements: ProxyElements,
  state: ProxyState,
  dependencies: ProxyActionsDependencies,
  view: ProxyView,
): ProxyActions => {
  const context = { dependencies, elements, state, view };
  return {
    beginDialogLoad: () => beginDialogLoad(context),
    bind: () => bindProxyActions(context),
    completeDialogLoad: (loadGeneration, loaded) =>
      completeDialogLoad(context, loadGeneration, loaded),
    endDialogSession: (restore) => endDialogSession(context, restore),
    loadState: (preserveDirtyDraft, loadGeneration) =>
      loadApplicationProxyState(context, preserveDirtyDraft, loadGeneration),
    savePending: () => savePendingApplicationProxy(context),
  };
};
