import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
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
      mainSource.indexOf('chatService.shutdown();', beforeQuit),
    );
  });

  it('quits without asking when nobody can answer', () => {
    // No window, still loading, or a crashed renderer: asking would hang the quit forever.
    expect(mainSource).toMatch(
      /const canAsk =\s+window !== null &&\s+!window\.isDestroyed\(\) &&\s+!window\.webContents\.isLoading\(\) &&\s+!window\.webContents\.isCrashed\(\);/,
    );
    // A second attempt while the question is outstanding forces it through.
    expect(mainSource).toMatch(
      /if \(!canAsk \|\| quitConfirmationPending\) \{\s+quitConfirmationPending = false;\s+isQuitting = true;\s+app\.quit\(\);/,
    );
    // A duplicate launch has no window and nothing to protect.
    expect(mainSource).toMatch(
      /if \(!hasSingleInstanceLock\) \{[\s\S]*?isQuitting = true;\s+app\.quit\(\);/,
    );
  });

  it('never questions an OS shutdown', () => {
    // Windows kills the process regardless, so a dialog here would only delay losing the same work.
    expect(mainSource).toMatch(
      /\.on\('session-end', \(\) => \{\s+isQuitting = true;\s+quitConfirmationPending = false;\s+\}\);/,
    );
  });

  it('quits only on an affirmative reply and clears the pending flag either way', () => {
    expect(mainSource).toMatch(
      /ipcMain\.on\('app:confirm-quit', \(event, confirmed: unknown\) => \{\s+validateSender\(event\);\s+quitConfirmationPending = false;\s+if \(confirmed !== true\) \{\s+return;\s+\}\s+isQuitting = true;\s+app\.quit\(\);/,
    );
  });

  it('routes the tray quit through the same confirmation as every other path', () => {
    expect(mainSource).toContain('click: requestQuit,');
    expect(mainSource).not.toMatch(/click: \(\) => \{\s+isQuitting = true;\s+app\.quit\(\);/);
  });

  it('exposes the handshake on the bridge in both directions', () => {
    expect(contractsSource).toContain('onAppQuitRequested: (listener: () => void) => Unsubscribe;');
    expect(contractsSource).toContain('confirmQuit: (confirmed: boolean) => void;');
    expect(preloadSource).toContain("ipcRenderer.on('app:quit-requested', callback);");
    expect(preloadSource).toContain("ipcRenderer.send('app:confirm-quit', confirmed);");
  });
});
