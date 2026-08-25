export type OnboardingStatus = 'completed' | 'in-progress' | 'pending' | 'skipped';

export type OnboardingStep = 'engine' | 'model' | 'prepare' | 'project' | 'ready';

export type OnboardingEngine = 'claude' | 'codex';

export type OnboardingModelChoice =
  'api' | 'chatgpt-subscription' | 'claude-subscription' | 'domestic';

export type OnboardingDomesticModel =
  'deepseek' | 'doubao' | 'glm-cn' | 'kimi-open' | 'minimax-cn' | 'qwen-cn';

export interface OnboardingState {
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  domesticModel?: OnboardingDomesticModel;
  engine?: OnboardingEngine;
  flowVersion: number;
  modelChoice?: OnboardingModelChoice;
  status: OnboardingStatus;
  updatedAt?: number;
}

export interface OnboardingProgressInput {
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  domesticModel?: OnboardingDomesticModel;
  engine?: OnboardingEngine;
  modelChoice?: OnboardingModelChoice;
}
