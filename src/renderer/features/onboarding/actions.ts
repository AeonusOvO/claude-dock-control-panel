import type { OnboardingStep } from '../../../shared/contracts';
import type { OnboardingElements } from './elements';
import { scanOnboardingEnvironment } from './environment';
import {
  activeProjectName,
  applyPersistedOnboarding,
  isOnboardingDomesticModel,
  isOnboardingEngine,
  isOnboardingModelChoice,
  isOnboardingStep,
  type OnboardingMutableState,
  type OnboardingFeatureDependencies,
} from './state';
import type { OnboardingView } from './view';

const trapOnboardingFocus = (elements: OnboardingElements, event: KeyboardEvent): void => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    elements.shell.querySelectorAll<HTMLElement>(
      'button:not(:disabled):not([hidden]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.closest('[hidden]'));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};

const bindOnboardingSelections = (
  elements: OnboardingElements,
  state: OnboardingMutableState,
  view: OnboardingView,
  showToast: OnboardingFeatureDependencies['showToast'],
  persist: () => Promise<void>,
  bind: (element: HTMLElement, type: 'change' | 'click', listener: () => void) => void,
): void => {
  const report = (error: unknown, fallback: string): void => {
    showToast(error instanceof Error ? error.message : fallback, 'error');
  };
  for (const button of elements.engineButtons) {
    bind(button, 'click', () => {
      const engine = button.dataset.onboardingEngine;
      if (!isOnboardingEngine(engine)) return;
      state.engine = engine;
      view.renderSelection();
      void persist().catch((error: unknown) => report(error, '无法保存引擎选择。'));
    });
  }
  for (const button of elements.modelButtons) {
    bind(button, 'click', () => {
      const modelChoice = button.dataset.onboardingModelChoice;
      if (!isOnboardingModelChoice(modelChoice)) return;
      state.modelChoice = modelChoice;
      if (modelChoice === 'domestic' && !state.domesticModel) state.domesticModel = 'deepseek';
      if (modelChoice !== 'domestic') state.domesticModel = undefined;
      view.renderSelection();
      void persist().catch((error: unknown) => report(error, '无法保存模型选择。'));
    });
  }
  bind(elements.domesticModelSelect, 'change', () => {
    if (!isOnboardingDomesticModel(elements.domesticModelSelect.value)) return;
    state.modelChoice = 'domestic';
    state.domesticModel = elements.domesticModelSelect.value;
    view.renderSelection();
    void persist().catch((error: unknown) => report(error, '无法保存国产模型选择。'));
  });
};

export const bindOnboardingActions = (
  elements: OnboardingElements,
  state: OnboardingMutableState,
  view: OnboardingView,
  dependencies: OnboardingFeatureDependencies,
): (() => void) => {
  const cleanups: Array<() => void> = [];
  const bind = <K extends keyof HTMLElementEventMap>(
    element: HTMLElement | Document,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void => {
    element.addEventListener(type, listener as EventListener);
    cleanups.push(() => element.removeEventListener(type, listener as EventListener));
  };
  const persist = async (): Promise<void> => {
    applyPersistedOnboarding(
      state,
      await window.controlPanel.updateOnboardingProgress({
        completedSteps: state.completedSteps,
        currentStep: state.currentStep,
        ...(state.domesticModel ? { domesticModel: state.domesticModel } : {}),
        ...(state.engine ? { engine: state.engine } : {}),
        ...(state.modelChoice ? { modelChoice: state.modelChoice } : {}),
      }),
    );
  };
  const moveTo = async (next: OnboardingStep): Promise<void> => {
    const previous = state.currentStep;
    if (!state.completedSteps.includes(previous)) state.completedSteps.push(previous);
    state.currentStep = next;
    try {
      await persist();
      state.currentStep = previous;
      view.showStep(next);
      if (next === 'prepare') void scanOnboardingEnvironment(elements, state);
    } catch (error) {
      state.currentStep = previous;
      dependencies.showToast(
        error instanceof Error ? error.message : '无法保存引导进度。',
        'error',
      );
    }
  };
  const returnTo = (step: OnboardingStep): void => {
    const previous = state.currentStep;
    state.currentStep = step;
    void persist()
      .then(() => {
        state.currentStep = previous;
        view.showStep(step, 'backward');
      })
      .catch((error: unknown) => {
        state.currentStep = previous;
        dependencies.showToast(
          error instanceof Error ? error.message : '无法返回上一步。',
          'error',
        );
      });
  };
  const dismiss = async (): Promise<void> => {
    try {
      applyPersistedOnboarding(state, await window.controlPanel.skipOnboarding());
      view.close();
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法保存引导状态。',
        'error',
      );
    }
  };
  const resetAndOpen = async (
    source: 'settings' | 'workspace',
    trigger: HTMLElement,
  ): Promise<void> => {
    const rect = trigger.getBoundingClientRect();
    if (source === 'settings') dependencies.closeSettingsDialog();
    try {
      applyPersistedOnboarding(state, await window.controlPanel.resetOnboarding());
      view.open(source, rect);
    } catch (error) {
      dependencies.showToast(
        error instanceof Error ? error.message : '无法重新打开入门向导。',
        'error',
      );
      if (source === 'settings') dependencies.reopenSettingsDialog();
    }
  };

  bindOnboardingSelections(
    elements,
    state,
    view,
    dependencies.showToast,
    persist,
    (element, type, listener) => bind(element, type, listener),
  );
  for (const button of elements.progressButtons) {
    bind(button, 'click', () => {
      const step = button.dataset.onboardingProgressStep;
      if (isOnboardingStep(step) && !button.disabled) returnTo(step);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-onboarding-back]')) {
    bind(button, 'click', () => {
      const step = button.dataset.onboardingBack;
      if (isOnboardingStep(step)) returnTo(step);
    });
  }
  bind(elements.engineNextButton, 'click', () => {
    if (state.engine) void moveTo('model');
  });
  bind(elements.modelNextButton, 'click', () => {
    if (state.modelChoice) void moveTo('prepare');
  });
  bind(elements.prepareNextButton, 'click', () => void moveTo('project'));
  bind(elements.recheckButton, 'click', () => void scanOnboardingEnvironment(elements, state));
  bind(elements.projectPicker, 'click', () => {
    elements.projectPicker.disabled = true;
    void dependencies
      .openDirectoryPicker()
      .then(async () => {
        state.workspace = await window.controlPanel.getWorkspace();
        view.renderProject();
      })
      .catch((error: unknown) => {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法读取工作区。',
          'error',
        );
      })
      .finally(() => {
        elements.projectPicker.disabled = false;
      });
  });
  bind(elements.projectNextButton, 'click', () => {
    if (activeProjectName(state.workspace)) void moveTo('ready');
  });
  bind(elements.completeButton, 'click', () => {
    if (!state.engine || !state.modelChoice) return;
    elements.completeButton.disabled = true;
    void window.controlPanel
      .completeOnboarding()
      .then((persisted) => {
        applyPersistedOnboarding(state, persisted);
        dependencies.selectRailTab('projects');
        view.close();
      })
      .catch((error: unknown) => {
        dependencies.showToast(
          error instanceof Error ? error.message : '无法完成入门向导。',
          'error',
        );
      })
      .finally(() => {
        elements.completeButton.disabled = false;
      });
  });
  bind(elements.dismissButton, 'click', () => void dismiss());
  bind(elements.resumeButton, 'click', () => void resetAndOpen('workspace', elements.resumeButton));
  bind(
    elements.settingsButton,
    'click',
    () => void resetAndOpen('settings', elements.settingsButton),
  );
  bind(document, 'keydown', (event) => {
    if (elements.shell.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void dismiss();
    } else {
      trapOnboardingFocus(elements, event);
    }
  });

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
};
