import type { OnboardingState } from '../../../shared/contracts';
import { findClaudeProvider, type ClaudeProviderId } from '../../../shared/claude/providers';
import {
  claudeConfigForm,
  connectionWizardChoiceProgress,
  connectionWizardChoiceStep,
  connectionWizardConfigureProgress,
  connectionWizardConfigureStep,
  connectionWizardNextButton,
  connectionWizardPreviousButton,
  connectionWizardStatus,
  connectionWizardViewport,
  environmentSetup,
  providerSpecialSetup,
} from './form-elements';
import type { ConnectionFormDeps } from './form-dependencies';
import type { ConnectionFormState } from './form-state';

const onboardingProvider = (state: OnboardingState): ClaudeProviderId | undefined => {
  if (state.modelChoice === 'claude-subscription') return 'anthropic';
  if (state.modelChoice === 'chatgpt-subscription') return 'chatgpt-subscription';
  if (state.modelChoice === 'domestic') return state.domesticModel ?? 'deepseek';
  if (state.modelChoice === 'api') return 'custom';
  return undefined;
};

export interface ConnectionFormWizardActions {
  dispose: () => void;
  initializeFromOnboarding: () => Promise<void>;
  render: () => void;
  showChoice: () => void;
}

interface ConnectionActionsMotion {
  animateFrom: (first: DOMRect) => void;
  cancel: () => void;
  getRect: () => DOMRect;
}

const cssTimeToMilliseconds = (value: string, fallback: number): number => {
  const normalized = value.trim();
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  if (normalized.endsWith('ms')) return parsed;
  if (normalized.endsWith('s')) return parsed * 1000;
  return fallback;
};

const createConnectionActionsMotion = (element: HTMLElement): ConnectionActionsMotion => {
  let active: Animation | undefined;
  let generation = 0;

  const cancel = (): void => {
    generation += 1;
    const previous = active;
    active = undefined;
    previous?.cancel();
    delete element.dataset.motion;
  };

  const animateFrom = (first: DOMRect): void => {
    const last = element.getBoundingClientRect();
    const deltaX = first.left - last.left;
    const deltaY = first.top - last.top;
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      typeof element.animate !== 'function' ||
      (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5)
    ) {
      return;
    }

    const styles = window.getComputedStyle(element);
    const duration = cssTimeToMilliseconds(
      styles.getPropertyValue('--dur-4'),
      cssTimeToMilliseconds(styles.getPropertyValue('--dur-enter'), 240),
    );
    const easing =
      styles.getPropertyValue('--ease-spring').trim() || 'cubic-bezier(0.16, 1, 0.3, 1)';
    const currentGeneration = ++generation;
    element.dataset.motion = 'flip';
    const animation = element.animate(
      [
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ],
      { duration, easing },
    );
    active = animation;
    const cleanup = (): void => {
      if (currentGeneration !== generation) return;
      active = undefined;
      delete element.dataset.motion;
    };
    animation.addEventListener('finish', cleanup, { once: true });
    animation.addEventListener('cancel', cleanup, { once: true });
  };

  return { animateFrom, cancel, getRect: () => element.getBoundingClientRect() };
};

export const createConnectionFormWizardActions = (
  deps: ConnectionFormDeps,
  formState: ConnectionFormState,
  applyPresetUi: (providerId: ClaudeProviderId, preserveValues: boolean) => void,
): ConnectionFormWizardActions => {
  let transitionGeneration = 0;
  const connectionWizardActions = connectionWizardPreviousButton.closest<HTMLElement>(
    '.connection-wizard-actions',
  );
  if (!connectionWizardActions) {
    throw new Error('接入向导操作条缺失。');
  }
  const actionsMotion = createConnectionActionsMotion(connectionWizardActions);

  const operationBusy = (): boolean =>
    formState.managedChatGptOperations.busy ||
    deps.connectionFeature.isTestInProgress() ||
    deps.connectionFeature.isRemedyInProgress();

  const render = (): void => {
    const configure = formState.wizardStep === 'configure';
    const busy = operationBusy();
    const progressMatchesCurrentScope = formState.managedChatGptProgress?.sessionId === undefined;
    const interruptible =
      progressMatchesCurrentScope &&
      formState.managedChatGptProgress?.active === true &&
      formState.managedChatGptProgress.interruptible;
    connectionWizardChoiceProgress.dataset.state = configure ? 'completed' : 'active';
    connectionWizardConfigureProgress.dataset.state = configure ? 'active' : 'pending';
    connectionWizardChoiceProgress.disabled = !configure || (busy && !interruptible);
    connectionWizardConfigureProgress.disabled = true;
    connectionWizardPreviousButton.disabled = !configure || (busy && !interruptible);
    connectionWizardNextButton.disabled =
      busy ||
      !formState.selectedProviderId ||
      (configure &&
        formState.selectedProviderId !== 'chatgpt-subscription' &&
        !formState.connectionEnvironmentReady);

    if (!configure) {
      const provider = findClaudeProvider(formState.selectedProviderId);
      connectionWizardStatus.textContent = provider ? `已选择 ${provider.label}` : '请选择模型来源';
      connectionWizardNextButton.textContent = '下一步';
      return;
    }
    connectionWizardNextButton.textContent = '下一步';
    if (progressMatchesCurrentScope && formState.managedChatGptProgress?.active) {
      connectionWizardStatus.textContent = interruptible
        ? `${formState.managedChatGptProgress.detail} · 可返回并取消`
        : `${formState.managedChatGptProgress.detail} · 当前步骤不可打断`;
    } else if (deps.connectionFeature.isTestInProgress()) {
      connectionWizardStatus.textContent = '正在真实测试连接，完成前不可返回';
    } else if (deps.connectionFeature.isRemedyInProgress()) {
      connectionWizardStatus.textContent = '正在修复接入配置，完成前不可返回';
    } else if (
      formState.selectedProviderId !== 'chatgpt-subscription' &&
      !formState.connectionEnvironmentReady
    ) {
      connectionWizardStatus.textContent = '请先完成 Claude Code 环境准备';
    } else {
      const providerLabel =
        formState.selectedProviderId === 'chatgpt-subscription'
          ? 'ChatGPT 官方订阅'
          : (findClaudeProvider(formState.selectedProviderId)?.label ?? '模型');
      connectionWizardStatus.textContent = `正在配置下个对话使用的 ${providerLabel}`;
    }
  };

  const cleanupTransition = (generation: number): void => {
    if (generation !== transitionGeneration) return;
    const configure = formState.wizardStep === 'configure';
    connectionWizardChoiceStep.hidden = configure;
    connectionWizardConfigureStep.hidden = !configure;
    connectionWizardChoiceStep.classList.toggle('connection-wizard-step--active', !configure);
    connectionWizardConfigureStep.classList.toggle('connection-wizard-step--active', configure);
    connectionWizardChoiceStep.classList.remove('connection-wizard-step--leaving');
    connectionWizardConfigureStep.classList.remove('connection-wizard-step--leaving');
    delete connectionWizardViewport.dataset.direction;
  };

  const showStep = (step: ConnectionFormState['wizardStep'], alignViewport = false): void => {
    if (formState.wizardStep === step) return;
    const actionsFirstRect = actionsMotion.getRect();
    actionsMotion.cancel();
    const previous =
      formState.wizardStep === 'choice'
        ? connectionWizardChoiceStep
        : connectionWizardConfigureStep;
    const next = step === 'choice' ? connectionWizardChoiceStep : connectionWizardConfigureStep;
    formState.wizardStep = step;
    connectionWizardViewport.dataset.direction = step === 'choice' ? 'backward' : 'forward';
    const generation = ++transitionGeneration;
    previous.hidden = false;
    previous.classList.remove('connection-wizard-step--active');
    previous.classList.add('connection-wizard-step--leaving');
    next.hidden = false;
    next.classList.remove('connection-wizard-step--leaving');
    next.classList.add('connection-wizard-step--active');
    render();
    if (alignViewport) {
      /* Align before the FLIP's final measurement. The browser applies this in the same frame, so
       * users see the capsule continue from its current screen position instead of a separate
       * smooth-scroll drift fighting the spring translation. */
      connectionWizardViewport.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
    actionsMotion.animateFrom(actionsFirstRect);
    next
      .querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
      )
      ?.focus({
        preventScroll: true,
      });
    window.setTimeout(() => cleanupTransition(generation), 380);
  };

  const returnToChoice = async (): Promise<void> => {
    if (!operationBusy()) {
      showStep('choice');
      return;
    }
    const progress = formState.managedChatGptProgress;
    if (!progress || progress.sessionId !== undefined || !progress.interruptible) {
      return;
    }
    connectionWizardPreviousButton.disabled = true;
    connectionWizardStatus.textContent = '正在取消 OpenAI 授权…';
    try {
      const result = await window.controlPanel.cancelManagedChatGptGatewaySetup();
      if (!result.ok) {
        formState.managedChatGptProgress = { ...progress, interruptible: false };
        deps.showToast(result.message ?? '当前授权步骤已经不可取消。', 'error');
        return;
      }
      deps.showToast(result.message ?? '已取消当前授权。');
      showStep('choice');
    } catch (error) {
      deps.showToast(error instanceof Error ? error.message : '无法取消当前授权。', 'error');
    } finally {
      render();
    }
  };

  const handlePrevious = (): void => {
    void returnToChoice();
  };
  const handleChoiceProgress = (): void => {
    if (formState.wizardStep === 'configure') void returnToChoice();
  };
  const handleNext = (): void => {
    if (!formState.selectedProviderId || operationBusy()) return;
    if (formState.wizardStep === 'choice') {
      showStep('configure', true);
      return;
    }
    if (
      formState.selectedProviderId !== 'chatgpt-subscription' &&
      !formState.connectionEnvironmentReady
    ) {
      environmentSetup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      deps.showToast('请先安装或更新 Claude Code。', 'error');
      return;
    }
    if (formState.selectedProviderId === 'chatgpt-subscription') {
      const action = providerSpecialSetup.querySelector<HTMLButtonElement>(
        '.subscription-gateway-status > button',
      );
      if (!action || action.disabled) {
        deps.showToast('ChatGPT 接入状态正在准备，请稍候。');
        return;
      }
      action.click();
      return;
    }
    claudeConfigForm.requestSubmit();
  };

  connectionWizardPreviousButton.addEventListener('click', handlePrevious);
  connectionWizardChoiceProgress.addEventListener('click', handleChoiceProgress);
  connectionWizardNextButton.addEventListener('click', handleNext);

  return {
    dispose: () => {
      actionsMotion.cancel();
      connectionWizardPreviousButton.removeEventListener('click', handlePrevious);
      connectionWizardChoiceProgress.removeEventListener('click', handleChoiceProgress);
      connectionWizardNextButton.removeEventListener('click', handleNext);
    },
    initializeFromOnboarding: async () => {
      const onboarding = await window.controlPanel.getOnboardingState();
      if (
        !formState.selectedProviderId &&
        (onboarding.status === 'pending' || onboarding.status === 'in-progress')
      ) {
        const providerId = onboardingProvider(onboarding);
        if (providerId) applyPresetUi(providerId, false);
      }
      render();
    },
    render,
    showChoice: () => {
      if (!operationBusy()) showStep('choice');
    },
  };
};
