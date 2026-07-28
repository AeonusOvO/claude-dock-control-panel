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

  it('keeps confirmation and IME focus inside the renderer across window activation', () => {
    expect(rendererMarkup).toMatch(
      /<dialog[\s\S]*?id="confirmation-dialog"[\s\S]*?aria-labelledby="confirmation-dialog-title"[\s\S]*?<form method="dialog">/,
    );
    expect(rendererSource).toContain('confirmationDialog.showModal();');
    expect(rendererSource).toContain('previouslyFocused.focus({ preventScroll: true });');
    expect(rendererSource).not.toMatch(/window\.(?:alert|confirm)\(/);
    expect(rendererSource).toContain('const reconcileWorkspaceAfterActivation = async');
    expect(rendererSource).toContain('renderWorkspace(await window.controlPanel.getWorkspace());');
    expect(rendererSource).toMatch(
      /window\.addEventListener\('focus', \(\) => \{[\s\S]*?void reconcileWorkspaceAfterActivation\(\);/,
    );
    expect(rendererSource).toMatch(
      /document\.visibilityState === 'visible'[\s\S]*?void reconcileWorkspaceAfterActivation\(\);/,
    );
    expect(rendererStyles).toContain('.confirmation-dialog::backdrop');
    expect(rendererStyles).toContain(".confirmation-dialog[data-tone='danger']");
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

  it('keeps saved gateway and model history in the main flow before model configuration', () => {
    const advancedIndex = rendererMarkup.indexOf('class="connection-advanced-launch"');
    const historyIndex = rendererMarkup.indexOf('id="connection-history"');
    const configIndex = rendererMarkup.indexOf('id="claude-config-form"');

    expect(advancedIndex).toBeGreaterThan(0);
    expect(historyIndex).toBeGreaterThan(advancedIndex);
    expect(configIndex).toBeGreaterThan(historyIndex);
    expect(rendererSource).toContain(
      "appendParameter('接口 / 网关', entry.baseUrl || 'Anthropic 官方端点')",
    );
    expect(rendererSource).toContain("appendParameter('主模型', entry.model || '默认模型')");
    expect(rendererSource).toContain(
      "appendParameter('快速模型', entry.modelFast || entry.model || '跟随主模型')",
    );
    expect(rendererSource).not.toContain('connectionHistorySection');
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

  it('tests the saved connection in place and shows the busy state immediately', () => {
    expect(rendererSource).toMatch(
      /footerConnection\.addEventListener\('click', \(\) => \{\s+if \(connectionTestInProgress\) \{\s+return;\s+\}[\s\S]*?void runConnectionTest\(false, \{[\s\S]*?credentialAction: 'keep',/,
    );
    const footerHandler = rendererSource.slice(
      rendererSource.indexOf("footerConnection.addEventListener('click'"),
      rendererSource.indexOf("footerModel.addEventListener('click'"),
    );
    expect(footerHandler).not.toContain("selectRailTab('connection')");
    expect(footerHandler).not.toContain('setWorkbenchOpen(false)');
    expect(rendererSource).toMatch(
      /connectionTestInProgress = true;\s+renderConnectionTestPending\(\);\s+const knownState = claudeStates\.get\(status\.id\);[\s\S]*?renderClaudeState\(knownState\);/,
    );
    // The busy branch has to precede the tone branch, or a stale route health would overwrite it.
    expect(rendererSource).toMatch(
      /if \(connectionTestInProgress\) \{\s+footerConnection\.dataset\.tone = 'pending';\s+footerConnection\.disabled = true;\s+footerConnection\.setAttribute\('aria-busy', 'true'\);\s+footerConnectionLabel\.textContent = '正在检测连接';\s+\} else \{\s+footerConnection\.disabled = false;\s+footerConnection\.setAttribute\('aria-busy', 'false'\);/,
    );
    expect(rendererStyles).toContain(
      "#footer-connection[data-tone='pending'] .footer-connection-dot",
    );
    expect(rendererStyles).toContain('#footer-connection:disabled {');
    expect(rendererMarkup).toContain('<span id="footer-connection-label">连接待测试</span>');
  });

  it('turns the footer model and mode readouts into real menu triggers', () => {
    expect(rendererMarkup).toMatch(
      /<button id="footer-model" type="button" aria-haspopup="menu" aria-expanded="false">/,
    );
    expect(rendererMarkup).toMatch(
      /<button id="footer-mode" type="button" aria-haspopup="menu" aria-expanded="false">/,
    );
    expect(rendererMarkup).toContain(
      '<div class="footer-menu" id="footer-model-menu" role="menu" aria-label="切换模型" hidden>',
    );
    expect(rendererMarkup).toMatch(
      /id="footer-mode-menu"\s+role="menu"\s+aria-label="切换权限模式"\s+hidden/,
    );
    // Both menus join the one dismissal path rather than starting a second one.
    expect(rendererSource).toMatch(
      /!footerModelMenu\.contains\(event\.target as Node\) &&\s+!footerModeMenu\.contains\(event\.target as Node\)/,
    );
    expect(rendererSource).toMatch(
      /window\.addEventListener\('blur', \(\) => \{[\s\S]*?hideFooterMenus\(\);/,
    );
    // Narrow windows drop both readouts together, so the footer cannot overflow.
    expect(rendererStyles).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?#footer-mode,\s+#footer-model \{\s+display: none;/,
    );
  });

  it('lists every permission mode and routes the un-cyclable one through a relaunch', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']) {
      expect(rendererSource).toContain(`id: '${mode}',`);
    }
    // `dontAsk` is only reachable as a launch argument, so it must not be sent to the stepper.
    expect(rendererSource).toMatch(
      /if \(mode === 'dontAsk'\) \{\s+await relaunchClaudeSession\('「仅预批准」只能在会话启动时设定。', \{ permissionMode: mode \}\);/,
    );
    // Cross-endpoint models reuse the same relaunch instead of a second mechanism.
    expect(rendererSource).toMatch(
      /if \(!option\.sameEndpoint\) \{\s+await relaunchClaudeSession\(/,
    );
    expect(rendererSource).toContain('compactFirst: true,');
    expect(rendererSource).toContain('对话历史会通过 --continue 恢复');
    expect(rendererSource.indexOf("id: 'bypassPermissions',")).toBeLessThan(
      rendererSource.indexOf("id: 'auto',"),
    );
  });

  it('forwards Shift+Tab from the composer so the shortcut does not depend on terminal focus', () => {
    expect(rendererSource).toMatch(
      /if \(event\.key === 'Tab' && event\.shiftKey && !event\.ctrlKey && !event\.altKey\) \{\s+const status = activeStatus\(\);\s+if \(status\) \{\s+event\.preventDefault\(\);\s+window\.controlPanel\.writeTerminal\(status\.id, '\\x1b\[Z'\);/,
    );
    // xterm already emits the same CBT sequence, so its key handler stays untouched.
    expect(rendererSource).not.toContain("event.code === 'Tab'");
  });

  it('reads permission badges from xterm after screen deltas have been applied', () => {
    expect(rendererSource).toContain('const buffer = view.terminal.buffer.active;');
    expect(rendererSource).toContain('for (let row = buffer.baseY; row < end; row += 1) {');
    expect(rendererSource).toContain("buffer.getLine(row)?.translateToString(true) ?? ''");
    expect(rendererSource).toContain(
      'window.controlPanel.observeClaudePermissionMode(sessionId, mode);',
    );
    expect(rendererSource).toMatch(
      /view\.terminal\.write\(chunk, \(\) => \{\s+view\.appliedOutputRevision = Math\.max\(view\.appliedOutputRevision, revision\);\s+reportTerminalPermissionMode\(sessionId, view\);\s+answerReadyPermissionModeProbes\(sessionId, view\);/,
    );
    expect(rendererSource).toContain('requiredRevision <= view.appliedOutputRevision');
    expect(rendererSource).toContain(
      'window.controlPanel.onClaudePermissionModeProbe((sessionId, probeId) => {',
    );
    expect(rendererSource).toContain('view.appliedOutputRevision >= view.outputRevision');
    expect(rendererSource).toContain(
      'view.permissionModeProbes.push({ probeId, requiredRevision: view.outputRevision });',
    );
    expect(rendererSource).toContain('window.controlPanel.reportClaudePermissionModeProbe(');
  });
});
