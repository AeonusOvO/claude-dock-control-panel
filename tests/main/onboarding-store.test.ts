import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('starts new profiles at the engine step and resumes independent engine/model progress', () => {
    const root = createRoot();
    const store = new OnboardingStore(root);
    expect(store.get()).toEqual({
      completedSteps: [],
      currentStep: 'engine',
      flowVersion: 2,
      status: 'pending',
    });

    store.update({
      completedSteps: ['engine', 'model'],
      currentStep: 'prepare',
      engine: 'codex',
      modelChoice: 'chatgpt-subscription',
    });
    expect(new OnboardingStore(root).get()).toMatchObject({
      completedSteps: ['engine', 'model'],
      currentStep: 'prepare',
      engine: 'codex',
      modelChoice: 'chatgpt-subscription',
      status: 'in-progress',
    });
  });

  it('does not force the new flow over profiles with existing workspace evidence', () => {
    const root = createRoot();
    const workspaceDirectory = path.join(root, 'claude');
    mkdirSync(workspaceDirectory, { recursive: true });
    writeFileSync(path.join(workspaceDirectory, 'workspace.json'), '{"version":1,"projects":[]}');

    expect(new OnboardingStore(root).get()).toMatchObject({
      completedSteps: ['engine', 'model', 'prepare', 'project', 'ready'],
      currentStep: 'ready',
      status: 'completed',
    });
  });

  it('supports skip, reset and completion without persisting secrets', () => {
    const root = createRoot();
    const store = new OnboardingStore(root);
    expect(store.skip().status).toBe('skipped');
    expect(store.reset().status).toBe('pending');
    store.update({
      completedSteps: ['engine', 'model', 'prepare', 'project'],
      currentStep: 'ready',
      domesticModel: 'deepseek',
      engine: 'claude',
      modelChoice: 'domestic',
    });
    expect(store.complete()).toMatchObject({
      currentStep: 'ready',
      domesticModel: 'deepseek',
      engine: 'claude',
      modelChoice: 'domestic',
      status: 'completed',
    });
  });

  it('migrates the v1 combined path into independent v2 engine and model choices', () => {
    const root = createRoot();
    const directory = path.join(root, 'app-preferences');
    const storagePath = path.join(directory, 'onboarding.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      storagePath,
      JSON.stringify({
        completedSteps: ['welcome'],
        currentStep: 'prepare',
        flowVersion: 1,
        path: 'codex',
        status: 'in-progress',
        version: 1,
      }),
    );

    expect(new OnboardingStore(root).get()).toMatchObject({
      completedSteps: ['engine', 'model'],
      currentStep: 'prepare',
      engine: 'codex',
      flowVersion: 2,
      modelChoice: 'chatgpt-subscription',
    });
    expect(JSON.parse(readFileSync(storagePath, 'utf8'))).toMatchObject({
      version: 2,
    });
  });

  it('rejects forged progress and recovers from corrupt storage', () => {
    const root = createRoot();
    const store = new OnboardingStore(root);
    expect(() =>
      store.update({
        completedSteps: ['engine', 'unknown' as 'ready'],
        currentStep: 'prepare',
      }),
    ).toThrow('启动引导进度无效');
    expect(() => store.complete()).toThrow('请先完成引擎与模型选择');

    const directory = path.join(root, 'app-preferences');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'onboarding.json'), '{not-json');
    expect(new OnboardingStore(root).get().status).toBe('pending');
  });
});
