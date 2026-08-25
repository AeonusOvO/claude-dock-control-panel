import { requiredElement } from '../../platform/dom';

export const createOnboardingElements = () => ({
  checklist: requiredElement<HTMLElement>('#onboarding-checklist'),
  completeButton: requiredElement<HTMLButtonElement>('#onboarding-complete'),
  dismissButton: requiredElement<HTMLButtonElement>('#onboarding-dismiss'),
  projectDetail: requiredElement<HTMLElement>('#onboarding-project-detail'),
  projectHint: requiredElement<HTMLElement>('#onboarding-project-hint'),
  projectNextButton: requiredElement<HTMLButtonElement>('#onboarding-project-next'),
  projectPicker: requiredElement<HTMLButtonElement>('#onboarding-project-picker'),
  projectTitle: requiredElement<HTMLElement>('#onboarding-project-title'),
  progressButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-onboarding-progress-step]'),
  ),
  pathButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-onboarding-path]')),
  prepareHint: requiredElement<HTMLElement>('#onboarding-prepare-hint'),
  prepareNextButton: requiredElement<HTMLButtonElement>('#onboarding-prepare-next'),
  recheckButton: requiredElement<HTMLButtonElement>('#onboarding-recheck'),
  resumeButton: requiredElement<HTMLButtonElement>('#resume-onboarding'),
  settingsButton: requiredElement<HTMLButtonElement>('#settings-open-onboarding'),
  shell: requiredElement<HTMLElement>('#onboarding-shell'),
  steps: Array.from(document.querySelectorAll<HTMLElement>('[data-onboarding-step]')),
  summaryPath: requiredElement<HTMLElement>('#onboarding-summary-path'),
  summaryProject: requiredElement<HTMLElement>('#onboarding-summary-project'),
  toolCheck: requiredElement<HTMLElement>('[data-onboarding-check="tool"]'),
  toolDetail: requiredElement<HTMLElement>('#onboarding-tool-detail'),
  toolStatus: requiredElement<HTMLOutputElement>('#onboarding-tool-status'),
  toolTitle: requiredElement<HTMLElement>('#onboarding-tool-title'),
  viewport: requiredElement<HTMLElement>('#onboarding-viewport'),
  welcomeHint: requiredElement<HTMLElement>('#onboarding-welcome-hint'),
  welcomeNextButton: requiredElement<HTMLButtonElement>('#onboarding-welcome-next'),
});

export type OnboardingElements = ReturnType<typeof createOnboardingElements>;
