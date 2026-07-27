import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const rendererStyles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const rendererMarkup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

describe('renderer interaction lifecycle contract', () => {
  it('always releases resize pointer capture across interrupted window lifecycles', () => {
    expect(rendererSource).toContain("handle.addEventListener('lostpointercapture', finish)");
    expect(rendererSource).toContain('handle.releasePointerCapture(pointerId)');
    expect(rendererSource).toContain("window.addEventListener('blur', () => {");
    expect(rendererSource).toContain("document.addEventListener('visibilitychange', () => {");
    expect(rendererSource).toContain('cancelActiveResizes();');
  });

  it('opens the active xterm visibly and retries fitting across paint frames', () => {
    expect(rendererSource).toMatch(
      /container\.className = active\s*\?\s*'project-terminal project-terminal--active'/,
    );
    expect(rendererSource).toContain('const scheduleActiveTerminalFit = (): void => {');
    expect(rendererSource).toContain('let attemptsRemaining = 4;');
    expect(rendererSource).toContain('view?.container.getBoundingClientRect()');
  });

  it('defers composer focus until the matching terminal is running', () => {
    expect(rendererSource).toContain("status.phase !== 'running'");
    expect(rendererSource).toContain('pendingComposerFocusSessionId = sessionId;');
    expect(rendererSource).toContain('flushPendingComposerFocus();');
  });

  it('does not animate interactive rail pages through a transformed hit-test layer', () => {
    const pageAnimation = rendererStyles.match(/@keyframes railPageEnter\s*\{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;

    expect(pageAnimation).toBeDefined();
    expect(pageAnimation).not.toContain('transform:');
  });

  it('keeps the shell interactive while a real connection test runs in the background', () => {
    expect(rendererSource).toContain('let connectionTestInProgress = false;');
    expect(rendererSource).toContain('if (!status || connectionTestInProgress)');
    expect(rendererSource).toContain('界面与 PowerShell 仍可继续使用');
    expect(rendererSource).toMatch(
      /window\.setInterval\(\(\) => \{\s+if \(connectionTestInProgress\) \{\s+return;/,
    );
    expect(rendererStyles).toContain(".connection-test-result[data-tone='pending']");
    expect(rendererMarkup).toMatch(/id="connection-test-result"[\s\S]*?aria-live="polite"/);
  });

  it('checks all update sources after first paint and only reveals detected update actions', () => {
    expect(rendererMarkup).toMatch(/id="refresh-updates"[\s\S]*?aria-label="检查软件与插件更新"/);
    expect(rendererMarkup).toMatch(/id="install-update-claude"[^>]*hidden/);
    expect(rendererMarkup).toMatch(/id="install-router"[^>]*hidden/);
    expect(rendererMarkup).toMatch(/id="update-all-plugins"[^>]*hidden/);
    expect(rendererSource).toContain('void refreshAvailableUpdates(false);');
    expect(rendererSource).toMatch(
      /window\.setTimeout\(\(\) => \{\s+void refreshAvailableUpdates\(false\);/,
    );
    expect(rendererSource).toMatch(/if \(plugin\.updateAvailable\) \{\s+actions\.append/);
  });
});
