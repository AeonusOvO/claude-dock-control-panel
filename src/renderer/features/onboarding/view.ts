import type { OnboardingStep } from '../../../shared/contracts';
import type { OnboardingElements } from './elements';
import {
  activeProjectName,
  isOnboardingStep,
  PATH_LABELS,
  STEP_ORDER,
  type OnboardingMutableState,
} from './state';

export interface OnboardingView {
  close: () => void;
  dispose: () => void;
  open: (source: OnboardingMutableState['launchSource'], triggerRect?: DOMRect) => void;
  render: () => void;
  renderPath: () => void;
  renderProject: () => void;
  showStep: (next: OnboardingStep, direction?: 'backward' | 'forward') => void;
}

export const createOnboardingView = (
  elements: OnboardingElements,
  state: OnboardingMutableState,
  reopenSettingsDialog: () => void,
): OnboardingView => {
  const inertSiblings = new Map<HTMLElement, boolean>();
  let closeTimer: number | undefined;

  const setBackgroundInert = (inert: boolean): void => {
    for (const sibling of Array.from(elements.shell.parentElement?.children ?? [])) {
      if (!(sibling instanceof HTMLElement) || sibling === elements.shell) continue;
      if (inert) {
        inertSiblings.set(sibling, sibling.inert);
        sibling.inert = true;
      } else {
        sibling.inert = inertSiblings.get(sibling) ?? false;
      }
    }
    if (!inert) inertSiblings.clear();
  };

  const renderPath = (): void => {
    for (const button of elements.pathButtons) {
      button.setAttribute('aria-checked', String(button.dataset.onboardingPath === state.path));
    }
    elements.welcomeNextButton.disabled = state.path === undefined;
    elements.welcomeHint.textContent = state.path
      ? `已选择 ${PATH_LABELS[state.path]}`
      : '请选择一条路径继续';
    elements.summaryPath.textContent = state.path ? PATH_LABELS[state.path] : '尚未选择';
  };

  const renderProject = (): void => {
    const projectName = activeProjectName(state.workspace);
    const hasProject = Boolean(projectName);
    elements.projectTitle.textContent = projectName ?? '选择项目文件夹';
    elements.projectDetail.textContent = projectName
      ? '已作为当前安全工作范围，可点击更换'
      : '点击打开 Windows 文件夹选择器';
    elements.projectHint.textContent = hasProject ? '工作区已就绪' : '请选择一个项目后继续';
    elements.projectNextButton.disabled = !hasProject;
    elements.summaryProject.textContent = projectName ?? '尚未选择';
  };

  const renderProgress = (): void => {
    const currentIndex = STEP_ORDER.indexOf(state.currentStep);
    for (const button of elements.progressButtons) {
      const step = button.dataset.onboardingProgressStep;
      if (!isOnboardingStep(step)) continue;
      const completed =
        state.completedSteps.includes(step) || STEP_ORDER.indexOf(step) < currentIndex;
      button.dataset.state =
        step === state.currentStep ? 'active' : completed ? 'completed' : 'pending';
      button.disabled = !completed || step === state.currentStep;
      button.setAttribute('aria-current', step === state.currentStep ? 'step' : 'false');
    }
  };

  const render = (): void => {
    renderPath();
    renderProject();
    renderProgress();
  };

  const cleanupTransition = (generation: number): void => {
    if (generation !== state.transitionGeneration) return;
    for (const step of elements.steps) {
      const active = step.dataset.onboardingStep === state.currentStep;
      step.classList.toggle('onboarding-step--active', active);
      step.classList.remove('onboarding-step--leaving');
      step.hidden = !active;
    }
    delete elements.viewport.dataset.direction;
  };

  const showStep = (next: OnboardingStep, direction?: 'backward' | 'forward'): void => {
    const previous = state.currentStep;
    const resolvedDirection =
      direction ??
      (STEP_ORDER.indexOf(next) < STEP_ORDER.indexOf(previous) ? 'backward' : 'forward');
    state.currentStep = next;
    const generation = ++state.transitionGeneration;
    const previousElement = elements.steps.find((step) => step.dataset.onboardingStep === previous);
    const nextElement = elements.steps.find((step) => step.dataset.onboardingStep === next);
    if (!nextElement) return;
    elements.viewport.dataset.direction = resolvedDirection;
    if (previousElement && previousElement !== nextElement) {
      previousElement.classList.remove('onboarding-step--active');
      previousElement.classList.add('onboarding-step--leaving');
      previousElement.hidden = false;
    }
    nextElement.hidden = false;
    nextElement.classList.remove('onboarding-step--leaving');
    nextElement.classList.add('onboarding-step--active');
    render();
    const heading = nextElement.querySelector<HTMLElement>('h1, h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
    window.setTimeout(() => cleanupTransition(generation), 420);
  };

  const setOrigin = (triggerRect?: DOMRect): void => {
    const shellRect = elements.shell.getBoundingClientRect();
    const x = triggerRect
      ? triggerRect.left + triggerRect.width / 2 - shellRect.left
      : shellRect.width / 2;
    const y = triggerRect
      ? triggerRect.top + triggerRect.height / 2 - shellRect.top
      : shellRect.height / 2;
    elements.shell.style.setProperty('--onboarding-origin-x', `${Math.max(0, x)}px`);
    elements.shell.style.setProperty('--onboarding-origin-y', `${Math.max(0, y)}px`);
  };

  const open = (source: OnboardingMutableState['launchSource'], triggerRect?: DOMRect): void => {
    state.launchSource = source;
    elements.shell.hidden = false;
    setOrigin(triggerRect);
    setBackgroundInert(true);
    elements.dismissButton.textContent = source === 'settings' ? '返回设置' : '稍后再说';
    elements.shell.dataset.state = 'open';
    for (const step of elements.steps) {
      const active = step.dataset.onboardingStep === state.currentStep;
      step.hidden = !active;
      step.classList.toggle('onboarding-step--active', active);
      step.classList.remove('onboarding-step--leaving');
    }
    render();
    elements.steps
      .find((step) => step.dataset.onboardingStep === state.currentStep)
      ?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')
      ?.focus();
  };

  const finishClose = (): void => {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    closeTimer = undefined;
    elements.shell.hidden = true;
    elements.shell.dataset.state = 'closed';
    setBackgroundInert(false);
    if (state.launchSource === 'settings') {
      reopenSettingsDialog();
      window.setTimeout(() => elements.settingsButton.focus(), 0);
    } else {
      elements.resumeButton.focus({ preventScroll: true });
    }
  };

  const close = (): void => {
    if (elements.shell.hidden || elements.shell.dataset.state === 'closing') return;
    elements.shell.dataset.state = 'closing';
    const onAnimationEnd = (event: AnimationEvent): void => {
      if (event.target !== elements.shell.querySelector('.onboarding-surface')) return;
      elements.shell.removeEventListener('animationend', onAnimationEnd);
      finishClose();
    };
    elements.shell.addEventListener('animationend', onAnimationEnd);
    closeTimer = window.setTimeout(() => {
      elements.shell.removeEventListener('animationend', onAnimationEnd);
      finishClose();
    }, 420);
  };

  return {
    close,
    dispose: () => {
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      setBackgroundInert(false);
    },
    open,
    render,
    renderPath,
    renderProject,
    showStep,
  };
};
