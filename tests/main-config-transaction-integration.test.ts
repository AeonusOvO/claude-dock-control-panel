import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const coordinatorSource = readFileSync(
  new URL('../src/main/main-process-operation-coordinator.ts', import.meta.url),
  'utf8',
);
const runtimeSource = readFileSync(
  new URL('../src/main/claude-runtime.ts', import.meta.url),
  'utf8',
);

const sourceBetween = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

const handlerSource = (channel: string, nextChannel: string): string =>
  sourceBetween(mainSource, `'${channel}'`, `'${nextChannel}'`);

const expectSessionThenDirectoryOwnership = (source: string): void => {
  const sessionIndex = source.indexOf('withDevelopmentSessionOperation');
  const directoryIndex = source.indexOf('runClaudeProjectConfigTransaction');
  expect(sessionIndex).toBeGreaterThanOrEqual(0);
  expect(directoryIndex).toBeGreaterThan(sessionIndex);
};

describe('main project-config transaction integration', () => {
  it('reserves synchronously and separates async preparation from the profile commit', () => {
    const coordinatorRun = sourceBetween(
      coordinatorSource,
      '  public run<T>(',
      '  public owns(intent:',
    );
    expect(coordinatorRun).toMatch(
      /const intent = this\.reserve\(sessionId, cwd\);\s+return this\.execute\(intent, operation\);/,
    );

    const transaction = sourceBetween(
      coordinatorSource,
      'export const runOwnedConfigTransaction',
      '\n  });',
    );
    expect(transaction.indexOf('const snapshot = options.createSnapshot();')).toBeLessThan(
      transaction.indexOf('const prepared = await options.prepare();'),
    );
    expect(transaction.indexOf('const prepared = await options.prepare();')).toBeLessThan(
      transaction.indexOf('options.commit(prepared);'),
    );
    expect(transaction.indexOf('options.commit(prepared);')).toBeLessThan(
      transaction.indexOf('const state = await options.complete(prepared);'),
    );
    expect(transaction).toContain('savedSnapshot = options.createSnapshot();');
    expect(transaction).not.toContain('const saving = options.save();');
    expect(transaction).not.toContain('persists before its first await');
  });

  it('funnels every project-profile writer through the shared directory transaction', () => {
    const repair = handlerSource(
      'claude:router-repair-from-project',
      'claude:router-save-provider',
    );
    const saveProvider = handlerSource(
      'claude:router-save-provider',
      'claude:router-delete-provider',
    );
    const saveConfig = handlerSource('claude:save-config', 'claude:connection-history');
    const applyHistory = handlerSource(
      'claude:connection-history-apply',
      'claude:connection-history-delete',
    );
    const relaunch = handlerSource('claude:relaunch', 'claude:set-permission-mode');
    const bypass = handlerSource('claude:set-allow-bypass-permissions', 'claude:test-connection');

    for (const source of [repair, saveProvider, saveConfig, applyHistory, relaunch, bypass]) {
      expectSessionThenDirectoryOwnership(source);
    }

    expect(repair.indexOf('runClaudeProjectConfigTransaction')).toBeLessThan(
      repair.indexOf('repairRouterProviderFromProject'),
    );
    expect(saveProvider).toContain('if (!validatedInput.useForCurrentProject)');
    expect(saveProvider).toContain('runtime.saveRouterProvider(validatedInput, assertCurrent)');
    expect(saveConfig).toContain('runtime.prepareConnectionConfig(');
    expect(applyHistory).toContain('runtime.prepareConnectionHistory(');
    expect(bypass).toContain('runtime.commitAllowBypassPermissions(');

    expect(relaunch).toContain('const entryId = validatedInput.entryId;');
    expect(relaunch).toContain('if (!entryId) {');
    expect(relaunch).toContain('runtime.compactBeforeRelaunch(');
    expect(relaunch).toContain('runtime.prepareConnectionHistory(');
    expect(relaunch).not.toContain('createConfigSnapshot');
    expect(relaunch).not.toContain('RollbackCoordinator');
    expect(relaunch).not.toContain('runtime.relaunch(');

    const managedSave = sourceBetween(
      mainSource,
      'const verifyAndSaveManagedChatGptProject',
      'const validatePluginId',
    );
    expect(managedSave).toContain('runClaudeProjectConfigTransaction<PreparedClaudeConfigSave>');
  });

  it('keeps all raw profile writes inside synchronous runtime commit methods', () => {
    const preparedCommit = sourceBetween(
      runtimeSource,
      '  public commitPreparedConfig(',
      '  /** Performs fallible post-commit work',
    );
    const bypassCommit = sourceBetween(
      runtimeSource,
      '  public commitAllowBypassPermissions(',
      '  /**',
    );
    const routerRepair = sourceBetween(
      runtimeSource,
      '  public async repairRouterProviderFromProject(',
      '  private routeKindForConfig(',
    );

    expect(preparedCommit).toContain('this.configStore.save(');
    expect(preparedCommit).not.toContain('await ');
    expect(bypassCommit).toContain('this.configStore.setAllowBypassPermissions(');
    expect(bypassCommit).not.toContain('await ');
    expect(routerRepair.indexOf('this.configStore.createLaunchSnapshot(cwd)')).toBeLessThan(
      routerRepair.indexOf('await this.getRouterHealthState(true)'),
    );

    expect(runtimeSource.match(/this\.configStore\.save\(/g)).toHaveLength(1);
    expect(runtimeSource.match(/this\.configStore\.setAllowBypassPermissions\(/g)).toHaveLength(1);
    for (const removedWriter of [
      'public async saveConfig(',
      'public async saveConnectionConfig(',
      'public async applyConnectionHistory(',
      'public async relaunch(',
      'public async setAllowBypassPermissions(',
      'public async repairRouterFromProject(',
    ]) {
      expect(runtimeSource).not.toContain(removedWriter);
    }
  });
});
