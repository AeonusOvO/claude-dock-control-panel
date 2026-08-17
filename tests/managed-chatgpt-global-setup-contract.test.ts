import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contractsSource = readFileSync(
  new URL('../src/shared/contracts.ts', import.meta.url),
  'utf8',
);
const preloadSource = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');

const sourceBetween = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

describe('managed ChatGPT projectless setup contract', () => {
  it('keeps the isolated bridge setup API project-optional', () => {
    const setupContract = sourceBetween(
      contractsSource,
      'setupManagedChatGptGateway: (',
      'installCcSwitch:',
    );
    expect(setupContract).toMatch(/sessionId\?: string/);
    expect(setupContract).toMatch(/forceLogin\?: boolean/);

    const preloadSetup = sourceBetween(
      preloadSource,
      'setupManagedChatGptGateway: (sessionId, forceLogin) =>',
      'setManagedChatGptGatewayModel:',
    );
    expect(preloadSetup).toMatch(
      /ipcRenderer\.invoke\(\s*'claude:managed-chatgpt-gateway-setup',\s*sessionId,\s*forceLogin \?\? false/,
    );
  });

  it('routes an omitted project directly to the global install and authorization flow', () => {
    const setupHandler = sourceBetween(
      mainSource,
      "ipcMain.handle(\n    'claude:managed-chatgpt-gateway-setup'",
      "ipcMain.handle(\n    'claude:managed-chatgpt-gateway-model'",
    );
    expect(setupHandler).toMatch(
      /if \(sessionId === undefined\) \{\s*return setupManagedChatGptGatewayGlobally\(forceLogin\);\s*\}\s*const validatedSessionId = validateSessionId\(sessionId\);/,
    );

    const globalSetup = sourceBetween(
      mainSource,
      'const performManagedChatGptGatewayGlobalSetup = async (',
      'const managedChatGptConfigInput = (',
    );
    expect(globalSetup).toContain('requireManagedChatGptGateway().setup(forceLogin');
    expect(globalSetup).toContain(
      'managedChatGptGlobalSetup.run(() => performManagedChatGptGatewayGlobalSetup(forceLogin))',
    );
  });

  it('submits setup without returning early when there is no active project', () => {
    const runSetup = sourceBetween(
      rendererSource,
      'const runSetup = async (',
      "action.addEventListener('click'",
    );
    expect(runSetup).toContain('const sessionId = workspaceState.activeSessionId || undefined;');
    expect(runSetup).toContain('runManagedChatGptOperation(');
    expect(runSetup).toContain(
      'window.controlPanel.setupManagedChatGptGateway(operationSessionId, forceLogin)',
    );
    expect(runSetup).not.toMatch(/if \(\s*!sessionId\s*\) \{[\s\S]*?\breturn\b/);
    expect(runSetup).not.toMatch(
      /if \(\s*!workspaceState\.activeSessionId\s*\) \{[\s\S]*?\breturn\b/,
    );
  });

  it('routes the renderer click through the tested setup coordinator', () => {
    const runSetup = sourceBetween(
      rendererSource,
      'const runSetup = async (',
      "action.addEventListener('click'",
    );
    expect(runSetup).toContain('runManagedChatGptOperation(');
    expect(runSetup).toContain(
      'window.controlPanel.setupManagedChatGptGateway(operationSessionId, forceLogin)',
    );
    expect(runSetup).toContain('button.disabled = managedChatGptOperations.busy;');
  });
});
