export type OnboardingStatus = 'completed' | 'in-progress' | 'pending' | 'skipped';

export type OnboardingStep = 'prepare' | 'project' | 'ready' | 'welcome';

export type OnboardingPath = 'claude' | 'codex' | 'provider';

export interface OnboardingState {
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  flowVersion: number;
  path?: OnboardingPath;
  status: OnboardingStatus;
  updatedAt?: number;
}

export interface OnboardingProgressInput {
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  path?: OnboardingPath;
}
