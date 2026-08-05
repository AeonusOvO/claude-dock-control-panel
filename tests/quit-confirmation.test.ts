import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const rendererMarkup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const rendererStyles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const contractsSource = readFileSync(
  new URL('../src/shared/contracts.ts', import.meta.url),
  'utf8',
);

/*
 * Quitting is a handshake: `before-quit` cancels itself, the renderer decides whether a streaming
 * conversation is worth protecting, and the reply latches `isQuitting` so the second pass runs the
 * teardown. Every escape hatch in that loop is load-bearing — a missing one either loses a reply or
 * leaves a process the user cannot close — so each is pinned here.
 */
describe('quit confirmation handshake', () => {
  it('bounces an unlatched quit back through the renderer instead of tearing down', () => {
    expect(mainSource).toMatch(
      /app\.on\('before-quit', \(event\) => \{[\s\S]*?if \(!isQuitting\) \{\s+event\.preventDefault\(\);\s+requestQuit\(\);\s+return;\s+\}/,
    );
    // The teardown must sit after that guard, or a cancelled quit would still shut the runtimes down.
    const beforeQuit = mainSource.indexOf("app.on('before-quit'");
    expect(beforeQuit).toBeGreaterThan(-1);
    expect(mainSource.indexOf('requestQuit();', beforeQuit)).toBeLessThan(
      mainSource.indexOf('shutdownRuntimeForQuit();', beforeQuit),
    );
  });

  it('always asks when the renderer can answer and only bypasses a missing renderer', () => {
    // No window, still loading, or a crashed renderer: asking would hang the quit forever.
    expect(mainSource).toMatch(
      /const canAsk =\s+window !== null &&\s+!window\.isDestroyed\(\) &&\s+!window\.webContents\.isLoading\(\) &&\s+!window\.webContents\.isCrashed\(\);/,
    );
    // A second attempt while the question is outstanding forces it through.
    expect(mainSource).toMatch(
      /if \(!canAsk \|\| quitConfirmationPending\) \{[\s\S]*?quitConfirmationPending = false;\s+void beginControlledQuit\(true\);/,
    );
    expect(mainSource).not.toMatch(/if \(leases\.length === 0\)/);
    expect(mainSource).toContain('id: `terminal:${id}`');
    expect(mainSource).toContain("phase === 'running' || phase === 'starting'");
    // A duplicate launch has no window and nothing to protect.
    expect(mainSource).toMatch(
      /if \(!hasSingleInstanceLock\) \{[\s\S]*?isQuitting = true;\s+app\.quit\(\);/,
    );
  });

  it('never questions an OS shutdown', () => {
    // Windows kills the process regardless, so a dialog here would only delay losing the same work.
    expect(mainSource).toMatch(
      /\.on\('session-end', \(\) => \{[\s\S]*?downloadEngine\?\.flushJournal\(\);[\s\S]*?isQuitting = true;\s+quitConfirmationPending = false;\s+\}\);/,
    );
  });

  it('quits only on an affirmative reply and clears the pending flag either way', () => {
    expect(mainSource).toMatch(
      /ipcMain\.on\('app:confirm-quit', \(event, confirmed: unknown\) => \{[\s\S]*?validateSender\(event\);[\s\S]*?quitConfirmationPending = false;[\s\S]*?if \(confirmed === 'retry' && quitResidualConfirmationPending\)[\s\S]*?if \(confirmed !== true\) \{[\s\S]*?return;\s+\}[\s\S]*?void beginControlledQuit\(forceWithResidualProcesses\);/,
    );
  });

  it('routes the tray quit through the same confirmation as every other path', () => {
    expect(mainSource).toContain('click: requestQuit,');
    expect(mainSource).not.toMatch(/click: \(\) => \{\s+isQuitting = true;\s+app\.quit\(\);/);
  });

  it('exposes the handshake on the bridge in both directions', () => {
    expect(contractsSource).toContain(
      'onAppQuitRequested: (listener: (request: AppQuitRequest) => void) => Unsubscribe;',
    );
    expect(contractsSource).toContain('confirmQuit: (decision: AppQuitDecision) => void;');
    expect(preloadSource).toContain("ipcRenderer.on('app:quit-requested', callback);");
    expect(preloadSource).toContain("ipcRenderer.send('app:confirm-quit', confirmed);");
    expect(preloadSource).toContain("ipcRenderer.send('app:quit-request-received');");
  });

  it('summarizes blocking leases and still exits if the renderer never receives the request', () => {
    expect(mainSource).toContain('const leases = busyRegistry?.list() ?? [];');
    expect(mainSource).toContain(
      "hasBlocking: leases.some(({ severity }) => severity === 'blocking')",
    );
    expect(mainSource).toMatch(
      /quitConfirmationTimer = setTimeout\(\(\) => \{[\s\S]*?void beginControlledQuit\(true\);[\s\S]*?\}, 3_000\);/,
    );
    expect(mainSource).toMatch(
      /async function beginControlledQuit[\s\S]*?claudePermissionBridge\?\.shutdown\(\);[\s\S]*?await runtimeProcessRegistry\?\.terminateAll\(\);/,
    );
    expect(mainSource).toContain('quitResidualConfirmationPending = true;');
    expect(mainSource).toContain('runtimeCleanupFailed: true,');
    expect(mainSource).toContain("if (confirmed === 'retry' && quitResidualConfirmationPending)");
    expect(mainSource).toMatch(
      /function shutdownRuntimeForQuit[\s\S]*?claudePermissionBridge\?\.shutdown\(\);[\s\S]*?workspace\.shutdown\(\);/,
    );
  });

  it('registers renderer conversation work in the authoritative busy registry', () => {
    expect(mainSource).toContain("ipcMain.handle('busy:set-conversation'");
    expect(mainSource).toContain("id: 'conversation:renderer'");
    expect(preloadSource).toContain("ipcRenderer.invoke('busy:set-conversation', busy)");
    expect(contractsSource).toContain(
      'setConversationBusy: (busy: boolean) => Promise<BusyLease[]>;',
    );
  });

  it('presents a task-aware, keyboard-safe dialog with the safe action first', () => {
    expect(rendererMarkup).toContain('id="quit-confirmation-dialog"');
    expect(rendererMarkup).toContain('可以直接关闭窗口，后台会继续运行。');
    const minimizeIndex = rendererMarkup.indexOf('id="quit-minimize"');
    const forceIndex = rendererMarkup.indexOf('id="quit-force"');
    const cancelIndex = rendererMarkup.indexOf('id="quit-cancel"');
    expect(minimizeIndex).toBeGreaterThan(0);
    expect(forceIndex).toBeGreaterThan(minimizeIndex);
    expect(cancelIndex).toBeGreaterThan(forceIndex);
    expect(rendererMarkup).toMatch(/id="quit-minimize"[^>]*autofocus/);
    expect(rendererSource).toContain("? '有操作正在进行，不建议退出'");
    expect(rendererSource).toContain(": '确认退出 ClaudeDock？';");
    expect(rendererSource).toContain('quitConfirmationList.hidden = request.leases.length === 0;');
    expect(rendererSource).toContain("? '中断会留下不完整状态' : '可稍后继续'");
    expect(rendererSource).toContain("confirmLabel: '仍要退出'");
    expect(rendererSource).toContain("? '重试安全清理'");
    expect(rendererSource).toContain("closeQuitConfirmation('retry');");
    expect(rendererStyles).toContain('.confirmation-dialog[open]');
    expect(rendererStyles).toContain('.quit-confirmation-dialog');
    expect(rendererStyles).toContain('var(--dur-3) var(--ease-decel)');
  });

  it('keeps minimize-to-tray inside the validated bridge', () => {
    expect(contractsSource).toContain('minimizeToTray: () => void;');
    expect(preloadSource).toContain("ipcRenderer.send('app:minimize-to-tray');");
    expect(mainSource).toMatch(
      /ipcMain\.on\('app:minimize-to-tray', \(event\) => \{\s+validateSender\(event\);\s+hideMainWindowToTray\(\);/,
    );
    expect(mainSource).toContain("if (appPreferencesStore.get().closeBehavior === 'exit') {");
  });
});
