import type {
  ApplicationProxyCandidate,
  ApplicationProxyState,
  ApplicationProxyView,
} from '../../../shared/contracts';
import type { ProxyElements } from './elements';
import type { ApplicationProxyDraftSnapshot, ProxyState } from './state';

export interface ProxyViewDependencies {
  isAdvancedConnectionDialogOpen: () => boolean;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  updateSettingsUnsavedIndicator: () => void;
}

export interface ProxyView {
  applyDraft: (draft: ApplicationProxyDraftSnapshot) => void;
  captureDraft: () => ApplicationProxyDraftSnapshot;
  draftMatches: (
    left: ApplicationProxyDraftSnapshot,
    right: ApplicationProxyDraftSnapshot,
  ) => boolean;
  isDirty: () => boolean;
  renderCandidates: (candidates: ApplicationProxyCandidate[]) => void;
  renderState: (proxyState: ApplicationProxyState, preserveDirtyDraft?: boolean) => void;
  syncInteractivity: () => void;
  viewSnapshot: (config: ApplicationProxyView) => ApplicationProxyDraftSnapshot;
}

interface ProxyViewContext {
  dependencies: ProxyViewDependencies;
  elements: ProxyElements;
  state: ProxyState;
}

const captureApplicationProxyDraft = (context: ProxyViewContext): ApplicationProxyDraftSnapshot => {
  const { elements } = context;
  return {
    enabled: elements.enabled.checked,
    host: elements.host.value,
    port: elements.port.value,
    protocol: elements.protocol.value === 'socks5' ? 'socks5' : 'http',
    scope: {
      application: elements.scopeApplication.checked,
      cli: elements.scopeCli.checked,
      conversation: elements.scopeConversation.checked,
    },
    username: elements.username.value,
  };
};

const applicationProxyViewSnapshot = (
  config: ApplicationProxyView,
): ApplicationProxyDraftSnapshot => ({
  enabled: config.enabled,
  host: config.host,
  port: config.port ? String(config.port) : '',
  protocol: config.protocol,
  scope: { ...config.scope },
  username: config.username,
});

const applicationProxyDraftMatches = (
  left: ApplicationProxyDraftSnapshot,
  right: ApplicationProxyDraftSnapshot,
): boolean =>
  left.enabled === right.enabled &&
  left.host === right.host &&
  left.port === right.port &&
  left.protocol === right.protocol &&
  left.username === right.username &&
  left.scope.application === right.scope.application &&
  left.scope.cli === right.scope.cli &&
  left.scope.conversation === right.scope.conversation;

const applicationProxyIsDirty = (context: ProxyViewContext): boolean => {
  const { elements, state } = context;
  return (
    (state.saved
      ? !applicationProxyDraftMatches(
          captureApplicationProxyDraft(context),
          applicationProxyViewSnapshot(state.saved),
        )
      : state.draftEdited) || elements.password.value.length > 0
  );
};

const syncApplicationProxyInteractivity = (context: ProxyViewContext): void => {
  const { elements, state } = context;
  const enabled = elements.enabled.checked && !state.initialLoadPending;
  elements.enabled.disabled = state.initialLoadPending;
  for (const container of [elements.configuration, elements.scope]) {
    container.inert = !enabled;
    container.setAttribute('aria-disabled', String(!enabled));
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input, select',
    )) {
      control.disabled = !enabled;
    }
  }
  if (enabled && elements.protocol.value === 'socks5') {
    elements.scopeCli.checked = false;
    elements.scopeCli.disabled = true;
  }
  elements.save.disabled = state.initialLoadPending || state.saveInProgress;
  elements.detect.disabled = state.initialLoadPending;
  elements.test.disabled =
    state.initialLoadPending ||
    state.testInProgress ||
    !state.saved?.enabled ||
    applicationProxyIsDirty(context);
};

const applyApplicationProxyDraft = (
  context: ProxyViewContext,
  draft: ApplicationProxyDraftSnapshot,
): void => {
  const { elements } = context;
  elements.enabled.checked = draft.enabled;
  elements.protocol.value = draft.protocol;
  elements.host.value = draft.host;
  elements.port.value = draft.port;
  elements.username.value = draft.username;
  elements.password.value = '';
  elements.scopeCli.checked = draft.scope.cli;
  elements.scopeApplication.checked = draft.scope.application;
  elements.scopeConversation.checked = draft.scope.conversation;
  syncApplicationProxyInteractivity(context);
};

const renderApplicationProxyState = (
  context: ProxyViewContext,
  proxyState: ApplicationProxyState,
  preserveDirtyDraft = true,
): void => {
  const { dependencies, elements, state } = context;
  const { config, test } = proxyState;
  const draft = captureApplicationProxyDraft(context);
  const preserveDraft =
    preserveDirtyDraft &&
    dependencies.isAdvancedConnectionDialogOpen() &&
    (state.draftEdited || applicationProxyIsDirty(context));
  state.saved = config;
  if (!preserveDraft) {
    applyApplicationProxyDraft(context, applicationProxyViewSnapshot(config));
  } else {
    const password = elements.password.value;
    applyApplicationProxyDraft(context, draft);
    elements.password.value = password;
    syncApplicationProxyInteractivity(context);
  }
  elements.credentialStatus.textContent = config.username
    ? config.passwordConfigured
      ? `账号 ${config.username} · 密码已由 Windows DPAPI 加密保存；密码框留空会保留。`
      : `账号 ${config.username} · 未保存密码。`
    : '未配置代理账号密码。';
  const enabledScopes = [
    config.scope.cli ? 'CLI' : undefined,
    config.scope.application ? 'ClaudeDock 自身网络' : undefined,
    config.scope.conversation ? '对话工作台' : undefined,
  ].filter(Boolean);
  elements.scopeSummary.textContent = config.enabled
    ? `${config.protocol.toUpperCase()} ${config.host}:${config.port} 已启用；作用域：${enabledScopes.join('、') || '无'}。`
    : '应用代理已关闭；所有受支持的进程均使用各自的默认连接设置。';
  elements.testResult.dataset.ok = String(test?.ok ?? false);
  elements.testResult.textContent = test
    ? `${test.message}${test.latencyMs === undefined ? '' : ` · ${test.latencyMs} ms`} · ${new Date(test.checkedAt).toLocaleTimeString()}`
    : '保存后可通过独立会话测试该端口，不会发送模型请求。';
  dependencies.updateSettingsUnsavedIndicator();
};

const renderApplicationProxyCandidates = (
  context: ProxyViewContext,
  candidates: ApplicationProxyCandidate[],
): void => {
  const { dependencies, elements, state } = context;
  elements.candidates.hidden = candidates.length === 0;
  elements.candidates.replaceChildren(
    ...candidates.map((candidate) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${candidate.label} · ${candidate.protocol.toUpperCase()} ${candidate.host}:${candidate.port}`;
      button.addEventListener('click', () => {
        state.draftEdited = true;
        elements.protocol.value = candidate.protocol;
        elements.host.value = candidate.host;
        elements.port.value = String(candidate.port);
        if (candidate.protocol === 'socks5') elements.scopeCli.checked = false;
        syncApplicationProxyInteractivity(context);
        dependencies.updateSettingsUnsavedIndicator();
        dependencies.showToast('已填入候选代理；请确认作用域后保存');
      });
      return button;
    }),
  );
};

export const createProxyView = (
  elements: ProxyElements,
  state: ProxyState,
  dependencies: ProxyViewDependencies,
): ProxyView => {
  const context = { dependencies, elements, state };
  return {
    applyDraft: (draft) => applyApplicationProxyDraft(context, draft),
    captureDraft: () => captureApplicationProxyDraft(context),
    draftMatches: applicationProxyDraftMatches,
    isDirty: () => applicationProxyIsDirty(context),
    renderCandidates: (candidates) => renderApplicationProxyCandidates(context, candidates),
    renderState: (proxyState, preserveDirtyDraft) =>
      renderApplicationProxyState(context, proxyState, preserveDirtyDraft),
    syncInteractivity: () => syncApplicationProxyInteractivity(context),
    viewSnapshot: applicationProxyViewSnapshot,
  };
};
