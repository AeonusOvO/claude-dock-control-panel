import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  OnboardingPath,
  OnboardingProgressInput,
  OnboardingState,
  OnboardingStep,
} from '../../shared/contracts';

const FLOW_VERSION = 1;
const STORAGE_VERSION = 1;
const ONBOARDING_STEPS: readonly OnboardingStep[] = ['welcome', 'prepare', 'project', 'ready'];
const ONBOARDING_PATHS: readonly OnboardingPath[] = ['claude', 'codex', 'provider'];

interface StoredOnboarding extends OnboardingState {
  version: number;
}

const freshState = (): OnboardingState => ({
  completedSteps: [],
  currentStep: 'welcome',
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
    if (stored) {
      return stored;
    }
    return this.hasLegacyUse() ? legacyCompletedState() : freshState();
  }

  public update(input: OnboardingProgressInput): OnboardingState {
    if (
      !ONBOARDING_STEPS.includes(input.currentStep) ||
      !Array.isArray(input.completedSteps) ||
      !input.completedSteps.every((step) => ONBOARDING_STEPS.includes(step)) ||
      (input.path !== undefined && !ONBOARDING_PATHS.includes(input.path))
    ) {
      throw new Error('启动引导进度无效。');
    }
    const next: OnboardingState = {
      completedSteps: uniqueSteps(input.completedSteps),
      currentStep: input.currentStep,
      flowVersion: FLOW_VERSION,
      ...(input.path ? { path: input.path } : {}),
      status: 'in-progress',
      updatedAt: Date.now(),
    };
    this.persist(next);
    return next;
  }

  public complete(pathChoice?: OnboardingPath): OnboardingState {
    if (pathChoice !== undefined && !ONBOARDING_PATHS.includes(pathChoice)) {
      throw new Error('启动引导路径无效。');
    }
    const current = this.get();
    const resolvedPath = pathChoice ?? current.path;
    const next: OnboardingState = {
      completedSteps: [...ONBOARDING_STEPS],
      currentStep: 'ready',
      flowVersion: FLOW_VERSION,
      ...(resolvedPath ? { path: resolvedPath } : {}),
      status: 'completed',
      updatedAt: Date.now(),
    };
    this.persist(next);
    return next;
  }

  public skip(): OnboardingState {
    const current = this.get();
    const next: OnboardingState = {
      ...current,
      status: 'skipped',
      updatedAt: Date.now(),
    };
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
      if (
        parsed.version !== STORAGE_VERSION ||
        parsed.flowVersion !== FLOW_VERSION ||
        !ONBOARDING_STEPS.includes(parsed.currentStep as OnboardingStep) ||
        !Array.isArray(parsed.completedSteps) ||
        !parsed.completedSteps.every((step) => ONBOARDING_STEPS.includes(step)) ||
        !['completed', 'in-progress', 'pending', 'skipped'].includes(parsed.status ?? '') ||
        (parsed.path !== undefined && !ONBOARDING_PATHS.includes(parsed.path))
      ) {
        return null;
      }
      return {
        completedSteps: uniqueSteps(parsed.completedSteps),
        currentStep: parsed.currentStep as OnboardingStep,
        flowVersion: FLOW_VERSION,
        ...(parsed.path ? { path: parsed.path } : {}),
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
