import type {
  OnboardingDomesticModel,
  OnboardingEngine,
  OnboardingModelChoice,
  OnboardingState,
  OnboardingStep,
  WorkspaceState,
} from '../../../shared/contracts';

export const STEP_ORDER: readonly OnboardingStep[] = [
  'engine',
  'model',
  'prepare',
  'project',
  'ready',
];

export const ENGINE_LABELS: Record<OnboardingEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const MODEL_CHOICE_LABELS: Record<OnboardingModelChoice, string> = {
  api: 'API / 中转站',
  'chatgpt-subscription': 'ChatGPT 官方订阅',
  'claude-subscription': 'Claude 官方订阅',
  domestic: '国产模型',
};

export const DOMESTIC_MODEL_LABELS: Record<OnboardingDomesticModel, string> = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  'glm-cn': '智谱 GLM',
  'kimi-open': 'Kimi',
  'minimax-cn': 'MiniMax',
  'qwen-cn': '通义千问',
};

export interface OnboardingMutableState {
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  domesticModel?: OnboardingDomesticModel;
  engine?: OnboardingEngine;
  launchSource: 'first-run' | 'settings' | 'workspace';
  modelChoice?: OnboardingModelChoice;
  scanGeneration: number;
  transitionGeneration: number;
  workspace: WorkspaceState;
}

export interface OnboardingFeatureDependencies {
  closeSettingsDialog: () => void;
  getWorkspaceState: () => WorkspaceState;
  openDirectoryPicker: () => Promise<void>;
  reopenSettingsDialog: () => void;
  selectRailTab: (tab: string) => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export const createOnboardingState = (): OnboardingMutableState => ({
  completedSteps: [],
  currentStep: 'engine',
  launchSource: 'first-run',
  scanGeneration: 0,
  transitionGeneration: 0,
  workspace: { activeSessionId: '', projects: [], sessions: [] },
});

export const applyPersistedOnboarding = (
  state: OnboardingMutableState,
  persisted: OnboardingState,
): void => {
  state.currentStep = persisted.currentStep;
  state.completedSteps = [...persisted.completedSteps];
  state.domesticModel = persisted.domesticModel;
  state.engine = persisted.engine;
  state.modelChoice = persisted.modelChoice;
};

export const activeProjectName = (workspace: WorkspaceState): string | undefined => {
  const activeSession = workspace.sessions.find(
    (session) => session.id === workspace.activeSessionId,
  );
  if (!activeSession) return undefined;
  return (
    workspace.projects.find((project) => project.sessionIds.includes(activeSession.id))?.name ??
    activeSession.cwd.split(/[\\/]/).filter(Boolean).at(-1)
  );
};

export const isOnboardingEngine = (value: string | undefined): value is OnboardingEngine =>
  value === 'claude' || value === 'codex';

export const isOnboardingModelChoice = (
  value: string | undefined,
): value is OnboardingModelChoice =>
  value === 'claude-subscription' ||
  value === 'chatgpt-subscription' ||
  value === 'domestic' ||
  value === 'api';

export const isOnboardingDomesticModel = (
  value: string | undefined,
): value is OnboardingDomesticModel =>
  value === 'deepseek' ||
  value === 'qwen-cn' ||
  value === 'glm-cn' ||
  value === 'kimi-open' ||
  value === 'minimax-cn' ||
  value === 'doubao';

export const isOnboardingStep = (value: string | undefined): value is OnboardingStep =>
  value === 'engine' ||
  value === 'model' ||
  value === 'prepare' ||
  value === 'project' ||
  value === 'ready';
