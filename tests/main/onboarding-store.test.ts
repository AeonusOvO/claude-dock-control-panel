import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingStore } from '../../src/main/stores/onboarding';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-onboarding-'));
  fixtureRoots.push(root);
  return root;
};

describe('onboarding store', () => {
  it('starts new profiles at the welcome step and resumes persisted progress', () => {
    const root = createRoot();
    const store = new OnboardingStore(root);
    expect(store.get()).toEqual({
      completedSteps: [],
      currentStep: 'welcome',
      flowVersion: 1,
      status: 'pending',
    });

    store.update({
      completedSteps: ['welcome'],
      currentStep: 'prepare',
      path: 'codex',
    });
    expect(new OnboardingStore(root).get()).toMatchObject({
      completedSteps: ['welcome'],
      currentStep: 'prepare',
      path: 'codex',
      status: 'in-progress',
    });
  });

  it('does not force the new flow over profiles with existing workspace evidence', () => {
    const root = createRoot();
    const workspaceDirectory = path.join(root, 'claude');
    mkdirSync(workspaceDirectory, { recursive: true });
    writeFileSync(path.join(workspaceDirectory, 'workspace.json'), '{"version":1,"projects":[]}');

    expect(new OnboardingStore(root).get()).toMatchObject({
      completedSteps: ['welcome', 'prepare', 'project', 'ready'],
      currentStep: 'ready',
      status: 'completed',
    });
  });

  it('supports skip, reset and completion without persisting secrets', () => {
    const root = createRoot();
    const store = new OnboardingStore(root);
    expect(store.skip().status).toBe('skipped');
    expect(store.reset().status).toBe('pending');
    expect(store.complete('provider')).toMatchObject({
      currentStep: 'ready',
      path: 'provider',
      status: 'completed',
    });
  });

  it('rejects forged progress and recovers from corrupt storage', () => {
    const root = createRoot();
    const store = new OnboardingStore(root);
    expect(() =>
      store.update({
        completedSteps: ['welcome', 'unknown' as 'ready'],
        currentStep: 'prepare',
      }),
    ).toThrow('启动引导进度无效');
    expect(() => store.complete('unknown' as 'claude')).toThrow('启动引导路径无效');

    const directory = path.join(root, 'app-preferences');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'onboarding.json'), '{not-json');
    expect(new OnboardingStore(root).get().status).toBe('pending');
  });
});
