import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const coordinatorSource = readFileSync(
  new URL('../src/main/main-process-operation-coordinator.ts', import.meta.url),
  'utf8',
);

describe('managed ChatGPT route cutover', () => {
  it('stops an active legacy PTY before setup and resumes only with the saved route', () => {
    expect(mainSource).toContain('防止登录期间继续消耗原中转站额度');
    expect(mainSource).toMatch(
      /const resumeAfterSetup = runtime\.isActive\(validatedSessionId\);[\s\S]*?withDevelopmentSessionOperation\([\s\S]*?withoutTerminalOperationInvalidation\([\s\S]*?workspace\.stopIfGeneration\([\s\S]*?status\.ptyGeneration[\s\S]*?runtime\.setInactive\([\s\S]*?status\.ptyGeneration[\s\S]*?assertCurrent\(\);/,
    );
    expect(mainSource).toMatch(
      /const resumeClaudeAfterManagedCutover[\s\S]*?prepareLaunch\(sessionId, cwd, 'continue'\)[\s\S]*?assertCurrent\(\)[\s\S]*?restartRuntimeTerminal\([\s\S]*?prepared\.environment[\s\S]*?prepared\.command[\s\S]*?ownedGeneration = ptyGeneration/,
    );
    expect(mainSource).toContain('旧路由会话已保持停止，不会继续消耗原中转站额度');
  });

  it('restores and publishes the exact pre-save config when cutover completion fails', () => {
    expect(mainSource).toMatch(
      /runOwnedConfigTransaction\(\{[\s\S]*?createSnapshot: \(\) => runtime\.createConfigSnapshot\(cwd\)[\s\S]*?restoreSnapshot: \(snapshot\) => runtime\.restoreConfigSnapshot\(cwd, snapshot\)[\s\S]*?save: \(\) => runtime\.saveConfig\(sessionId, cwd, input\)/,
    );
    expect(mainSource).toContain('publishRestoredState: publishRestoredClaudeProjectState');
    expect(mainSource).toContain('const projectState = managedConfigTransactionState(error);');
    expect(coordinatorSource).toMatch(
      /coordinator\.run\(options\.sessionId, options\.cwd[\s\S]*?const snapshot = options\.createSnapshot\(\);[\s\S]*?const saving = options\.save\(\);[\s\S]*?savedSnapshot = options\.createSnapshot\(\);[\s\S]*?let state = await saving/,
    );
    expect(coordinatorSource).toMatch(
      /class SessionConfigTransactionCoordinator[\s\S]*?private readonly tail[\s\S]*?await intent\.predecessor[\s\S]*?this\.active\.set/,
    );
    expect(coordinatorSource).toContain('const key = directoryKey(cwd);');
    expect(coordinatorSource).toMatch(
      /ownership\.assertCurrent\(\);[\s\S]*?assertRollbackOwnership[\s\S]*?isDeepStrictEqual[\s\S]*?restoreSnapshot\(snapshot\)[\s\S]*?state = await options\.readState\(\)[\s\S]*?publishRestoredState/,
    );
  });
});
