import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const claudeRuntimeSource = readFileSync(
  new URL('../src/main/claude-runtime.ts', import.meta.url),
  'utf8',
);
const mainProcessCoordinatorSource = readFileSync(
  new URL('../src/main/main-process-operation-coordinator.ts', import.meta.url),
  'utf8',
);

describe('main-process session operation ownership', () => {
  it('reconciles terminal failures and waits before destructive session cleanup', () => {
    expect(mainSource).toMatch(
      /enteredTerminalFailure\(previous, status\)[\s\S]*?terminalOperationInvalidationSuppressions\.has\(status\.id\)[\s\S]*?invalidateDevelopmentSessionOperation\(status\.id\)[\s\S]*?claudeRuntime\?\.setInactive\(status\.id, status\.ptyGeneration\)[\s\S]*?codexRuntime\?\.setInactive\(status\.id, status\.ptyGeneration\)/,
    );
    expect(mainSource).toContain(
      'await invalidateAndWaitForDevelopmentSessionOperation(validatedSessionId);',
    );
    expect(mainSource).toContain('await runOwnedProjectDirectoryClosure({');
    expect(mainSource).toContain(
      'invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,',
    );
    expect(mainSource).toMatch(
      /if \(!enteredFailure\) \{\s+continue;\s+\}\s+terminalOutputBatcher\.flush\(status\.id, status\.ptyGeneration\);[\s\S]*?mainWindow\?\.webContents\.send\('workspace:state', enriched\)/,
    );
  });

  it('keeps Codex launch under the same cancellable PTY lease', () => {
    const handler = mainSource.slice(
      mainSource.indexOf("'codex:launch'"),
      mainSource.indexOf("'claude:get-gateway-diagnostics'"),
    );
    expect(handler).toContain('withDevelopmentSessionOperation(validatedSessionId');
    expect(handler).toMatch(
      /assertOfficialProviderAllowed[\s\S]*?assertCurrent\(\)[\s\S]*?runtime\.prepareLaunch[\s\S]*?ownedGeneration = prepared\.predecessorPtyGeneration[\s\S]*?assertCurrent\(\)[\s\S]*?agentRuntimeStore\.get\(status\.cwd\) !== 'codex'[\s\S]*?restartRuntimeTerminal\([\s\S]*?ownedGeneration = ptyGeneration/,
    );
    expect(handler).toContain('if (launchPrepared || ownedGeneration !== undefined)');
  });

  it('cancels managed cutovers and runtime switches before stale resume work can write', () => {
    for (const channel of [
      "'claude:managed-chatgpt-gateway-setup'",
      "'claude:managed-chatgpt-gateway-model'",
    ]) {
      const start = mainSource.indexOf(channel);
      const nextHandler = mainSource.indexOf('ipcMain.handle', start + channel.length);
      const handler = mainSource.slice(start, nextHandler);
      expect(handler).toContain('withDevelopmentSessionOperation(validatedSessionId');
      expect(handler).toContain('assertCurrent();');
    }
    expect(mainSource).toMatch(
      /const resumeClaudeAfterManagedCutover[\s\S]*?prepareLaunch\(sessionId, cwd, 'continue'\)[\s\S]*?assertCurrent\(\)[\s\S]*?restartRuntimeTerminal\([\s\S]*?ownedGeneration = ptyGeneration/,
    );
    const runtimeHandler = mainSource.slice(
      mainSource.indexOf("'runtime:set'"),
      mainSource.indexOf("'project:add'"),
    );
    expect(runtimeHandler).toMatch(
      /projectRuntimeSwitchOperations\.switchRuntime\([\s\S]*?validatedSessionId[\s\S]*?status\.cwd[\s\S]*?selected/,
    );
    expect(mainSource).toMatch(
      /projectRuntimeSwitchOperations\.assertDevelopmentOperationAllowed\(initialStatus\.cwd\)[\s\S]*?managedConfigTransactions\.assertDevelopmentOperationAllowed\(initialStatus\.cwd, sessionId\)[\s\S]*?developmentSessionOperations\.run[\s\S]*?projectRuntimeSwitchOperations\.assertDevelopmentOperationAllowed\(currentStatus\.cwd\)[\s\S]*?managedConfigTransactions\.assertDevelopmentOperationAllowed\(currentStatus\.cwd, sessionId\)/,
    );
    expect(mainSource).toMatch(
      /const resolved = resolveDirectory[\s\S]*?managedConfigTransactions\.assertDevelopmentOperationAllowed\(resolved\)[\s\S]*?workspace\.openConversation/,
    );
    expect(mainSource).toContain(
      'acquireIsolation: () => acquireConfigTransactionIsolation(options.sessionId, options.cwd)',
    );
    expect(mainProcessCoordinatorSource).toMatch(
      /acquireDevelopmentIsolation[\s\S]*?intent\.isolationAcquired = true[\s\S]*?Promise\.all\(sessionsToInvalidate\.map\(invalidateAndWait\)\)/,
    );
    expect(mainProcessCoordinatorSource).toMatch(
      /options\.assertOperationOwnership\(\)[\s\S]*?await options\.acquireIsolation\(\)[\s\S]*?ownership\.assertCurrent\(\)[\s\S]*?options\.assertOperationOwnership\(\)[\s\S]*?const snapshot = options\.createSnapshot\(\)/,
    );
    expect(mainProcessCoordinatorSource).toMatch(
      /await Promise\.all\([\s\S]*?invalidateAndWait[\s\S]*?assertStable\(intent, true\)[\s\S]*?prepareProvider[\s\S]*?assertStable\(intent, true\)[\s\S]*?cleanupBeforeCommit[\s\S]*?assertStable\(intent, true\)[\s\S]*?commitRuntime/,
    );
    expect(mainProcessCoordinatorSource).toContain(
      'Persistence is deliberately the final synchronous commit.',
    );

    const claudeLaunchHandler = mainSource.slice(
      mainSource.indexOf("'claude:launch'"),
      mainSource.indexOf("'claude:command'"),
    );
    expect(claudeLaunchHandler).toMatch(
      /runtime\.prepareLaunch[\s\S]*?ownedGeneration = prepared\.predecessorPtyGeneration[\s\S]*?assertLaunchCurrent\(\)[\s\S]*?agentRuntimeStore\.get\(status\.cwd\) !== 'claude'[\s\S]*?restartRuntimeTerminal/,
    );

    const speedHandler = mainSource.slice(
      mainSource.indexOf("'claude:set-model-speed'"),
      mainSource.indexOf("'claude:permission-mode-observed'"),
    );
    expect(speedHandler).toMatch(
      /prepareModelSpeedRelaunch[\s\S]*?launchPrepared = true[\s\S]*?ownedGeneration = prepared\.predecessorPtyGeneration[\s\S]*?assertCurrent\(\)[\s\S]*?restartRuntimeTerminal/,
    );
  });

  it('owns permanent conversation deletion above every resume launch path', () => {
    expect(mainSource).toContain('await runOwnedClaudeConversationDeletion({');
    expect(mainSource).toContain(
      'sessionIdsForConversation: () => runtime.sessionIdsForConversation(cwd, conversationId),',
    );
    expect(mainSource).toContain(
      'invalidateAndWait: invalidateAndWaitForDevelopmentSessionOperation,',
    );
    expect(mainSource).toContain(
      'removePreferences: () => runtime.removeConversationPreferences(conversationId),',
    );
    expect(mainSource).toMatch(
      /claudeRuntime\.setConversationLaunchGuard[\s\S]*?claudeConversationLifecycle\.assertLaunchAllowed/,
    );

    const storedConversationHandler = mainSource.slice(
      mainSource.indexOf("'project:open-stored-conversation'"),
      mainSource.indexOf("'terminal:start'"),
    );
    expect(storedConversationHandler).toMatch(
      /assertLaunchAllowed[\s\S]*?runResume[\s\S]*?conversationOwnership\.assertCurrent\(\)[\s\S]*?prepareLaunchWithSession/,
    );

    const exactResumeHandler = mainSource.slice(
      mainSource.indexOf("'claude:launch-with-session'"),
      mainSource.indexOf("'claude:plugins-get'"),
    );
    expect(exactResumeHandler).toMatch(
      /runResume[\s\S]*?conversationOwnership\.assertCurrent\(\)[\s\S]*?prepareLaunchWithSession/,
    );
  });

  it('threads lease ownership through queued model command writes', () => {
    expect(mainSource).toMatch(
      /switchModel\([\s\S]*?validateModelOptionId\(optionId\),[\s\S]*?assertCurrent/,
    );
    expect(claudeRuntimeSource).toMatch(
      /public async switchModel\([\s\S]*?assertCurrent: \(\) => void = \(\) => undefined/,
    );
    expect(claudeRuntimeSource).toContain(
      'this.submitClaudeCommand(runtime, `/model ${option.model}`, assertCurrent)',
    );
    expect(claudeRuntimeSource).toMatch(
      /private submitClaudeCommand\([\s\S]*?assertCurrent\?\.\(\);[\s\S]*?return false;/,
    );
  });
});
