import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  OnboardingDomesticModel,
  OnboardingEngine,
  OnboardingModelChoice,
  OnboardingProgressInput,
  OnboardingState,
  OnboardingStep,
} from '../../shared/contracts';

const FLOW_VERSION = 2;
const STORAGE_VERSION = 2;
const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'engine',
  'model',
  'prepare',
  'project',
  'ready',
];
const ONBOARDING_ENGINES: readonly OnboardingEngine[] = ['claude', 'codex'];
const ONBOARDING_MODEL_CHOICES: readonly OnboardingModelChoice[] = [
  'claude-subscription',
  'chatgpt-subscription',
  'domestic',
  'api',
];
const ONBOARDING_DOMESTIC_MODELS: readonly OnboardingDomesticModel[] = [
  'deepseek',
  'qwen-cn',
  'glm-cn',
  'kimi-open',
  'minimax-cn',
  'doubao',
];

interface StoredOnboarding extends OnboardingState {
  version: number;
}

interface LegacyStoredOnboarding {
  completedSteps?: unknown;
  currentStep?: unknown;
  flowVersion?: unknown;
  path?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  version?: unknown;
}

const freshState = (): OnboardingState => ({
  completedSteps: [],
  currentStep: 'engine',
  flowVersion: FLOW_VERSION,
  status: 'pending',
});

const legacyCompletedState = (): OnboardingState => ({
  completedSteps: [...ONBOARDING_STEPS],
  currentStep: 'ready',
  flowVersion: FLOW_VERSION,
  status: 'completed',
});

const uniqueSteps = (steps: readonly OnboardingStep[]): OnboardingStep[] =>
  ONBOARDING_STEPS.filter((step) => steps.includes(step));

const selectionIsValid = ({
  domesticModel,
  engine,
  modelChoice,
}: Pick<OnboardingProgressInput, 'domesticModel' | 'engine' | 'modelChoice'>): boolean =>
  (engine === undefined || ONBOARDING_ENGINES.includes(engine)) &&
  (modelChoice === undefined || ONBOARDING_MODEL_CHOICES.includes(modelChoice)) &&
  (domesticModel === undefined || ONBOARDING_DOMESTIC_MODELS.includes(domesticModel)) &&
  (modelChoice === 'domestic' || domesticModel === undefined);

const legacySelection = (pathChoice: unknown): Pick<OnboardingState, 'engine' | 'modelChoice'> => {
  if (pathChoice === 'claude') {
    return { engine: 'claude', modelChoice: 'claude-subscription' };
  }
  if (pathChoice === 'codex') {
    return { engine: 'codex', modelChoice: 'chatgpt-subscription' };
  }
  if (pathChoice === 'provider') {
    return { engine: 'claude', modelChoice: 'api' };
  }
  return {};
};

const migrateLegacyState = (parsed: LegacyStoredOnboarding): OnboardingState | null => {
  if (
    parsed.version !== 1 ||
    parsed.flowVersion !== 1 ||
    !Array.isArray(parsed.completedSteps) ||
    !['completed', 'in-progress', 'pending', 'skipped'].includes(String(parsed.status ?? ''))
  ) {
    return null;
  }
  const legacySteps = ['welcome', 'prepare', 'project', 'ready'];
  if (
    !legacySteps.includes(String(parsed.currentStep)) ||
    !parsed.completedSteps.every((step) => legacySteps.includes(String(step)))
  ) {
    return null;
  }
  const completedSteps = parsed.completedSteps.flatMap((step): OnboardingStep[] => {
    if (step === 'welcome') return ['engine', 'model'];
    return [step as OnboardingStep];
  });
  const currentStep: OnboardingStep =
    parsed.currentStep === 'welcome' ? 'engine' : (parsed.currentStep as OnboardingStep);
  const selection = legacySelection(parsed.path);
  return {
    completedSteps:
      parsed.status === 'completed' ? [...ONBOARDING_STEPS] : uniqueSteps(completedSteps),
    currentStep: parsed.status === 'completed' ? 'ready' : currentStep,
    flowVersion: FLOW_VERSION,
    ...selection,
    status: parsed.status as OnboardingState['status'],
    ...(typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
      ? { updatedAt: parsed.updatedAt }
      : {}),
  };
};

export class OnboardingStore {
  private readonly directory: string;
  private readonly storagePath: string;
  private readonly userDataPath: string;

  public constructor(userDataPath: string) {
    this.userDataPath = userDataPath;
    this.directory = path.join(userDataPath, 'app-preferences');
    this.storagePath = path.join(this.directory, 'onboarding.json');
  }

  public get(): OnboardingState {
    const stored = this.read();
    if (stored) return stored;
    return this.hasLegacyUse() ? legacyCompletedState() : freshState();
  }

  public update(input: OnboardingProgressInput): OnboardingState {
    if (
      !ONBOARDING_STEPS.includes(input.currentStep) ||
      !Array.isArray(input.completedSteps) ||
      !input.completedSteps.every((step) => ONBOARDING_STEPS.includes(step)) ||
      !selectionIsValid(input)
    ) {
      throw new Error('启动引导进度无效。');
    }
    const next: OnboardingState = {
      completedSteps: uniqueSteps(input.completedSteps),
      currentStep: input.currentStep,
      flowVersion: FLOW_VERSION,
      ...(input.domesticModel ? { domesticModel: input.domesticModel } : {}),
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.modelChoice ? { modelChoice: input.modelChoice } : {}),
      status: 'in-progress',
      updatedAt: Date.now(),
    };
    this.persist(next);
    return next;
  }

  public complete(): OnboardingState {
    const current = this.get();
    if (!current.engine || !current.modelChoice) {
      throw new Error('请先完成引擎与模型选择。');
    }
    const next: OnboardingState = {
      ...current,
      completedSteps: [...ONBOARDING_STEPS],
      currentStep: 'ready',
      flowVersion: FLOW_VERSION,
      status: 'completed',
      updatedAt: Date.now(),
    };
    this.persist(next);
    return next;
  }

  public skip(): OnboardingState {
    const next: OnboardingState = { ...this.get(), status: 'skipped', updatedAt: Date.now() };
    this.persist(next);
    return next;
  }

  public reset(): OnboardingState {
    const next = freshState();
    this.persist(next);
    return next;
  }

  private hasLegacyUse(): boolean {
    const evidence = [
      path.join(this.userDataPath, 'app-preferences', 'app.json'),
      path.join(this.userDataPath, 'preferences', 'app.json'),
      path.join(this.userDataPath, 'claude', 'workspace.json'),
      path.join(this.userDataPath, 'claude', 'chat-profile.json'),
      path.join(this.userDataPath, 'claude', 'chat-history.json'),
      path.join(this.userDataPath, 'claude', 'connection-history.json'),
    ];
    return evidence.some((candidate) => existsSync(candidate));
  }

  private read(): OnboardingState | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this.storagePath, 'utf8'),
      ) as Partial<StoredOnboarding>;
      const migrated = migrateLegacyState(parsed);
      if (migrated) {
        this.persist(migrated);
        return migrated;
      }
      if (
        parsed.version !== STORAGE_VERSION ||
        parsed.flowVersion !== FLOW_VERSION ||
        !ONBOARDING_STEPS.includes(parsed.currentStep as OnboardingStep) ||
        !Array.isArray(parsed.completedSteps) ||
        !parsed.completedSteps.every((step) => ONBOARDING_STEPS.includes(step)) ||
        !['completed', 'in-progress', 'pending', 'skipped'].includes(parsed.status ?? '') ||
        !selectionIsValid(parsed)
      ) {
        return null;
      }
      return {
        completedSteps: uniqueSteps(parsed.completedSteps),
        currentStep: parsed.currentStep as OnboardingStep,
        ...(parsed.domesticModel ? { domesticModel: parsed.domesticModel } : {}),
        ...(parsed.engine ? { engine: parsed.engine } : {}),
        flowVersion: FLOW_VERSION,
        ...(parsed.modelChoice ? { modelChoice: parsed.modelChoice } : {}),
        status: parsed.status as OnboardingState['status'],
        ...(typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
          ? { updatedAt: parsed.updatedAt }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private persist(state: OnboardingState): void {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ ...state, version: STORAGE_VERSION }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.storagePath);
  }
}
