import type {
  ClaudeNextConversationConnectionState,
  SubscriptionState,
} from '../../../shared/contracts';
import {
  isSubscriptionProvider,
  type SubscriptionProvider,
} from '../../../shared/claude/subscriptions';
import type { ClaudeProviderId } from '../../../shared/claude/providers';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';

const manualPresets: Record<SubscriptionProvider, ClaudeProviderId> = {
  'kimi-subscription': 'kimi-code',
  'minimax-subscription-cn': 'minimax-cn',
  'minimax-subscription-global': 'minimax-global',
  'glm-subscription-cn': 'glm-cn',
  'glm-subscription-global': 'glm-global',
};

export const buildSubscriptionGuide = (
  form: ConnectionFormState,
  provider: SubscriptionProvider,
  applyPreset: (provider: ClaudeProviderId, preserve: boolean) => void,
): HTMLElement => {
  const root = document.createElement('section');
  root.className = 'domestic-subscription-guide';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const code = document.createElement('p');
  code.className = 'subscription-user-code';
  const consent = document.createElement('p');
  consent.textContent = '登录后会创建 ClaudeDock 专用套餐密钥。';
  consent.hidden = !provider.startsWith('glm-');
  const cost = document.createElement('p');
  cost.className = 'field-help connection-cost-notice';
  cost.textContent = '可能会消耗少量 token';
  const actions = document.createElement('div');
  actions.className = 'subscription-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button--secondary button--small';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => {
    void form.cancelSubscription?.();
  });
  const advanced = document.createElement('button');
  advanced.type = 'button';
  advanced.className = 'button button--secondary button--small';
  const manual = document.createElement('button');
  manual.type = 'button';
  manual.className = 'button button--secondary button--small';
  manual.textContent = '使用密钥';
  manual.addEventListener('click', () => applyPreset(manualPresets[provider], false));
  advanced.addEventListener('click', () => {
    form.advancedSettings = !form.advancedSettings;
    render();
  });
  const render = (): void => {
    const state = form.subscription;
    const matches = state?.provider === provider;
    const busy =
      form.subscriptionPending || state?.busy === true || form.managedChatGptOperations.busy;
    status.textContent = matches && state.message ? state.message : '登录账号，连接订阅。';
    code.textContent = matches && state.userCode ? `验证码：${state.userCode}` : '';
    code.hidden = !code.textContent;
    cancel.hidden = !state?.busy;
    cancel.disabled = !state?.cancellable;
    advanced.textContent = form.advancedSettings ? '极简设置' : '高级设置';
    advanced.setAttribute('aria-expanded', String(form.advancedSettings));
    advanced.disabled = busy;
    manual.hidden = !form.advancedSettings;
    manual.disabled = busy;
  };
  actions.append(cancel, advanced, manual);
  root.append(status, code, consent, cost, actions);
  form.renderSubscription = render;
  render();
  return root;
};

export const connectSubscriptionUi = (
  deps: ConnectionFormDeps,
  form: ConnectionFormState,
  applyNext: (state: ClaudeNextConversationConnectionState) => void,
  sync: () => void,
): (() => void) => {
  let disposed = false;
  const render = (): void => {
    if (disposed) return;
    form.renderSubscription?.();
    sync();
  };
  const receive = (state: SubscriptionState): void => {
    if (disposed || (form.subscription && state.revision < form.subscription.revision)) return;
    form.subscription = state;
    render();
  };
  const unsubscribe = window.controlPanel.onSubscriptionState(receive);
  void window.controlPanel
    .getSubscriptionState()
    .then(receive)
    .catch(() => undefined);
  const start = async (): Promise<void> => {
    const provider = form.selectedProviderId;
    if (
      disposed ||
      !isSubscriptionProvider(provider) ||
      form.subscriptionPending ||
      form.subscription?.busy ||
      form.managedChatGptOperations.busy ||
      deps.connectionFeature.isTestInProgress()
    )
      return;
    form.subscriptionPending = true;
    render();
    try {
      const result = await window.controlPanel.setupSubscription(provider);
      if (disposed) return;
      receive(result.state);
      if (result.state.attempt !== form.subscription?.attempt) return;
      if (result.ok && result.nextConnection?.config) {
        if (form.selectedProviderId === provider) applyNext(result.nextConnection);
        else {
          form.nextConnectionRevision += 1;
          form.nextConnection = result.nextConnection;
          deps.renderNextConnection();
        }
        form.connectionSucceeded?.();
      } else {
        deps.showToast(result.message, result.ok ? 'success' : 'error');
      }
    } catch {
      if (!disposed) deps.showToast('无法连接订阅，请重试。', 'error');
    } finally {
      form.subscriptionPending = false;
      render();
    }
  };
  form.startSubscription = () => {
    void start();
  };
  form.cancelSubscription = async () => {
    const state = form.subscription;
    if (!state?.attempt || !state.cancellable) return false;
    try {
      const result = await window.controlPanel.cancelSubscriptionSetup(state.attempt);
      if (disposed) return false;
      receive(result.state);
      if (!result.ok) deps.showToast(result.message, 'error');
      return result.ok;
    } catch {
      if (!disposed) deps.showToast('无法取消订阅连接，请重试。', 'error');
      return false;
    }
  };
  return () => {
    disposed = true;
    unsubscribe();
    form.startSubscription = undefined;
    form.cancelSubscription = undefined;
    form.renderSubscription = undefined;
  };
};
