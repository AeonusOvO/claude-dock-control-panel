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

  it('treats provider selection, grouping and follow-up steps as explicit UI state', () => {
    expect(rendererSource).toMatch(
      /if \(selectedProviderId === provider\.id\) \{\s+clearProviderSelection\(\);/,
    );
    expect(rendererSource).toMatch(
      /const clearProviderSelection[\s\S]*?providerSetup\.hidden = true;[\s\S]*?claudeConfigForm\.hidden = true;/,
    );
    expect(rendererSource).toContain(
      'const collapsedProviderGroups = new Set<ClaudeProviderGroupId>',
    );
    expect(rendererSource).toContain(
      "toggle.setAttribute('aria-expanded', String(!nextCollapsed))",
    );
    expect(rendererSource).toContain('content.inert = nextCollapsed;');
    expect(rendererStyles).toContain('container-type: inline-size;');
    expect(rendererStyles).toMatch(
      /@container provider-picker \(min-width: 290px\)[\s\S]*?repeat\(2,/,
    );
    expect(rendererStyles).toMatch(
      /@container provider-picker \(min-width: 470px\)[\s\S]*?repeat\(3,/,
    );
  });

  it('opens advanced connection tools in a themed cancellable modal', () => {
    expect(rendererMarkup).toMatch(/id="open-connection-advanced"[\s\S]*?aria-haspopup="dialog"/);
    expect(rendererMarkup).toMatch(
      /<dialog[\s\S]*?id="connection-advanced-dialog"[\s\S]*?id="cancel-connection-advanced"[\s\S]*?id="complete-connection-advanced"/,
    );
    expect(rendererSource).toContain(
      'advancedConnectionSnapshot = captureAdvancedConnectionSnapshot();',
    );
    expect(rendererSource).toContain(
      'restoreAdvancedConnectionSnapshot(advancedConnectionSnapshot)',
    );
    expect(rendererSource).toContain('connectionAdvancedDialog.showModal();');
    expect(rendererStyles).toContain('.connection-advanced-dialog::backdrop');
  });

  it('collapses an already-selected activity tab without losing the terminal', () => {
    expect(rendererSource).toContain('applyRailTab(selectedRailTab === tab ? undefined : tab);');
    expect(rendererSource).toContain(
      "workspace.classList.toggle('workspace--rail-collapsed', collapsed)",
    );
    expect(rendererSource).toContain('controlPanel.inert = collapsed;');
    expect(rendererStyles).toContain('.workspace.workspace--rail-collapsed');
    expect(rendererStyles).toContain(
      'grid-template-columns: var(--activity-rail-w) 0 0 minmax(0, 1fr);',
    );
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
