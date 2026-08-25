import type {
  OnboardingPath,
  OnboardingState,
  OnboardingStep,
  WorkspaceState,
} from '../../../shared/contracts';

export const STEP_ORDER: readonly OnboardingStep[] = ['welcome', 'prepare', 'project', 'ready'];

export const PATH_LABELS: Record<OnboardingPath, string> = {
  claude: 'Claude Code',
  codex: 'ChatGPT / Codex',
  provider: 'API 服务商',
};

export interface OnboardingMutableState {
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  launchSource: 'first-run' | 'settings' | 'workspace';
  path?: OnboardingPath;
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
  currentStep: 'welcome',
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
  state.path = persisted.path;
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

export const isOnboardingPath = (value: string | undefined): value is OnboardingPath =>
  value === 'claude' || value === 'codex' || value === 'provider';

export const isOnboardingStep = (value: string | undefined): value is OnboardingStep =>
  value === 'welcome' || value === 'prepare' || value === 'project' || value === 'ready';
