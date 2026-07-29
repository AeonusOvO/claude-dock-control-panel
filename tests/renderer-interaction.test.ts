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

  it('opens the active xterm visibly, retries cold fits and debounces live resizes', () => {
    expect(rendererSource).toMatch(
      /container\.className = active\s*\?\s*'project-terminal project-terminal--active'/,
    );
    expect(rendererSource).toContain('const retryTerminalFitUntilMeasured = (): void => {');
    expect(rendererSource).toContain('let attemptsRemaining = 4;');
    expect(rendererSource).toContain('const debounceTerminalFit = (): void => {');
    expect(rendererSource).toContain('const TERMINAL_FIT_DEBOUNCE_MS = 100;');
    expect(rendererSource).toContain('view?.container.getBoundingClientRect()');
    expect(rendererStyles).toContain('.project-terminal--active:focus-within');
    expect(rendererStyles).toMatch(
      /\.project-terminal--active:focus-within\s*\{[\s\S]*?var\(--accent-line\)[\s\S]*?var\(--accent-tint\)/,
    );
  });

  it('defers composer focus until the matching terminal is running', () => {
    expect(rendererSource).toContain("status.phase !== 'running'");
    expect(rendererSource).toContain('pendingComposerFocusSessionId = sessionId;');
    expect(rendererSource).toContain('flushPendingComposerFocus();');
  });

  it('offers a project-scoped official Codex preparation path without hiding its safety boundary', () => {
    expect(rendererMarkup).toMatch(
      /id="runtime-picker"[\s\S]*?id="runtime-claude"[\s\S]*?id="runtime-codex"/,
    );
    expect(rendererMarkup).toContain('官方 ChatGPT 订阅通道');
    expect(rendererMarkup).toMatch(
      /id="codex-install-step"[\s\S]*?id="codex-account-step"[\s\S]*?id="codex-project-step"/,
    );
    expect(rendererMarkup).toContain('默认仅写当前工作区');
    expect(rendererSource).toMatch(
      /if \(!state\.installation\.installed\) \{\s+state = await installOrUpdateCodex\(\);/,
    );
    expect(rendererSource).toMatch(
      /if \(state\.requiresOpenaiAuth && !state\.account\) \{\s+await startCodexLogin\('browser', true\);/,
    );
    expect(rendererSource).toContain("await launchCodex('new');");
    expect(rendererStyles).toMatch(
      /\.runtime-option input \{[\s\S]*?inset: 0;[\s\S]*?width: 100%;/,
    );
    expect(rendererStyles).toContain("body[data-agent-runtime='codex'] .codex-workbench-page");
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
    expect(rendererSource).toContain('collapsedClaudeProviderGroups(providerId)');
    expect(rendererSource).toMatch(
      /const enteringConnection = tab === 'connection'[\s\S]*?applyDefaultProviderGroupExpansion\(lastProvider\)/,
    );
    expect(rendererStyles).toContain('container-type: inline-size;');
    expect(rendererStyles).toMatch(
      /@container provider-picker \(min-width: 290px\)[\s\S]*?repeat\(2,/,
    );
    expect(rendererStyles).toMatch(
      /@container provider-picker \(min-width: 470px\)[\s\S]*?repeat\(3,/,
    );
  });

  it('opens global settings from the bottom rail and keeps advanced connection tools categorized', () => {
    expect(rendererMarkup).toMatch(/id="open-connection-advanced"[\s\S]*?aria-haspopup="dialog"/);
    expect(rendererMarkup).toContain('activity-rail__button--settings');
    expect(rendererMarkup).toMatch(
      /data-settings-tab="general"[\s\S]*?data-settings-tab="connection"/,
    );
    expect(rendererMarkup).toMatch(
      /id="settings-launch-at-login"[\s\S]*?id="settings-theme"[\s\S]*?id="settings-language"[\s\S]*?id="settings-version"/,
    );
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
    expect(rendererMarkup).toMatch(
      /id="connection-advanced-content"[\s\S]*?id="complete-connection-advanced"/,
    );
    expect(rendererMarkup).toContain('id="claude-api-key-helper-policy"');
    expect(rendererSource).toContain('connectionAdvancedContent.append(');
    expect(rendererSource).toContain('credentialSourceSettings,');
    expect(rendererStyles).toContain('.connection-advanced-dialog::backdrop');
  });

  it('keeps saved gateway and model history in the main flow before model configuration', () => {
    const historyIndex = rendererMarkup.indexOf('id="connection-history"');
    const configIndex = rendererMarkup.indexOf('id="claude-config-form"');

    expect(rendererMarkup).not.toContain('class="connection-advanced-launch"');
    expect(historyIndex).toBeGreaterThan(0);
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

  it('provides independently configured model chat with a separate workspace', () => {
    expect(rendererMarkup).toMatch(/data-rail-tab="chat"[\s\S]*?>\s*对话\s*</);
    expect(rendererMarkup).toContain('id="chat-config-form"');
    expect(rendererMarkup).toContain('id="chat-shell"');
    expect(rendererMarkup).toContain('id="chat-composer"');
    expect(rendererSource).toContain('window.controlPanel.startChat({');
    expect(rendererSource).toContain('window.controlPanel.onChatStream(handleChatStream);');
    expect(rendererSource).toContain("mainView = 'chat';");
    expect(rendererStyles).toContain('.chat-message--user');
  });

  it('places chat above the project/connection group and exposes its complete conversation state', () => {
    const chatNavigation = rendererMarkup.indexOf('data-rail-tab="chat"');
    const projectNavigation = rendererMarkup.indexOf('data-rail-tab="projects"');
    const connectionNavigation = rendererMarkup.indexOf('data-rail-tab="connection"');

    expect(chatNavigation).toBeGreaterThan(0);
    expect(chatNavigation).toBeLessThan(projectNavigation);
    expect(projectNavigation).toBeLessThan(connectionNavigation);
    expect(rendererMarkup).toContain('id="chat-context-total"');
    expect(rendererMarkup).toContain('id="chat-token-usage"');
    expect(rendererMarkup).toContain('id="new-chat"');
    expect(rendererMarkup).toContain('id="test-chat-connection"');
    expect(rendererMarkup).toContain('id="chat-history-list"');
    expect(rendererSource).toContain('window.controlPanel.testChatConnection(chatConfigInput())');
    expect(rendererSource).toContain('window.controlPanel.saveChatConversation({');
    expect(rendererSource).toContain('window.controlPanel.getChatConversations()');
    expect(rendererSource).toContain('window.controlPanel.deleteChatConversation(conversation.id)');
    // Typing updates the usage readout and re-measures the composer: it autosizes like the terminal's.
    expect(rendererSource).toMatch(
      /chatInput\.addEventListener\('input', \(\) => \{\s+renderChatUsage\(\);\s+resizeChatComposer\(\);/,
    );
    expect(rendererSource).toContain(
      "estimateChatUsage([...chatMessages, { content: draft, role: 'user' }])",
    );
  });

  it('focuses the chat composer from navigation and uses the active theme for its focus animation', () => {
    expect(rendererSource).toContain('const focusChatInputAfterNavigation = (): void => {');
    expect(rendererSource).toContain('chatInput.focus({ preventScroll: true });');
    expect(rendererSource).toMatch(
      /const toggleRailTab[\s\S]*?if \(tab === 'chat'\) \{\s+focusChatInputAfterNavigation\(\);/,
    );
    /*
     * The focus flourish is now one shared rule for both composers rather than a chat-only keyframe:
     * they are the same control, so they must answer focus the same way. Asserting the shared selector
     * is what keeps chat from drifting back to a plainer treatment than the terminal's.
     */
    expect(rendererStyles).toMatch(
      /\.terminal-composer textarea:focus,\s*\.chat-composer textarea:focus\s*\{[\s\S]*?composerFocusIn[\s\S]*?var\(--accent-ring\)[\s\S]*?var\(--accent-tint\)/,
    );
    expect(rendererStyles).toContain('@keyframes composerFocusIn');
    expect(rendererStyles).not.toContain('chatComposerFocusIn');
  });

  it('gives chat history the full rail and keeps artifact details compact and structured', () => {
    expect(rendererMarkup).not.toContain('模型接入改到了「对话」右上角');
    expect(rendererStyles).toMatch(
      /\.rail-page--chat\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/,
    );
    expect(rendererStyles).toMatch(
      /\.chat-history__list\s*\{[\s\S]*?flex:\s*1;[\s\S]*?overflow-y:\s*auto;/,
    );
    expect(rendererStyles).not.toContain('max-height: 248px;');
    expect(rendererMarkup).toContain('class="artifact-details__intro"');
    expect(rendererMarkup).toContain('class="artifact-details__section-heading"');
    expect(rendererStyles).toMatch(
      /\.artifact-details__body\s*\{[\s\S]*?align-content:\s*start;[\s\S]*?grid-auto-rows:\s*max-content;/,
    );
  });

  it('uses theme-aware typography and glow feedback without hover lift', () => {
    expect(rendererSource).toContain("import '@fontsource-variable/roboto';");
    expect(rendererSource).toContain("import '@fontsource-variable/hanken-grotesk';");
    expect(rendererSource).toContain("import '@fontsource-variable/newsreader';");
    expect(rendererSource).toContain(
      'document.documentElement.style.colorScheme = definition.appearance;',
    );
    // The generic ladders the stylesheet spells everywhere must alias the theme-authored tokens,
    // otherwise switching themes repaints colours but leaves motion, geometry and leading behind.
    expect(rendererStyles).toContain('--ease-standard: var(--ease-enter);');
    expect(rendererStyles).toContain('--ease-decel: var(--ease-spring);');
    expect(rendererStyles).toContain('--ease-accel: var(--ease-exit);');
    expect(rendererStyles).toContain('--dur-2: var(--dur-micro);');
    expect(rendererStyles).toContain('--dur-4: var(--dur-enter);');
    expect(rendererStyles).toContain('--r-md: var(--r-theme-md);');
    expect(rendererStyles).toContain('--press-lg: var(--press-theme);');
    expect(rendererStyles).toContain('--lh-prose: calc(1 + (var(--lh-body) - 1) * 0.79);');
    expect(rendererStyles).toContain('--ls-body: calc(var(--ls-title) * 0.25);');
    expect(rendererStyles).toContain('@keyframes chatMessageEnter');
    expect(rendererStyles).not.toMatch(/:hover[^{]*\{[^}]*transform:\s*translateY\(/s);
  });

  it('exposes permanent history deletion with confirmation in every stored conversation row', () => {
    expect(rendererMarkup).toContain('data-conversation-context-action="delete"');
    expect(rendererSource).toContain('const deleteStoredConversation = async');
    expect(rendererSource).toContain('window.controlPanel.deleteClaudeSession(');
    expect(rendererSource).toContain("deleteButton.className = 'history-item__delete';");
    expect(rendererSource).toContain("confirmLabel: '永久删除'");
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

  it('keeps official preflight separate while the footer runs the saved real connection test', () => {
    const footerHandler = rendererSource.slice(
      rendererSource.indexOf("footerConnection.addEventListener('click'"),
      rendererSource.indexOf("footerModel.addEventListener('click'"),
    );
    expect(footerHandler).toContain("if (activeDevelopmentRuntime() === 'codex')");
    expect(footerHandler).toContain('openNetworkPreflightDialog()');
    expect(footerHandler).toContain(
      'runConnectionTest(false, savedClaudeConfigInput(state.config))',
    );
    expect(footerHandler).not.toContain("selectRailTab('connection')");
    expect(footerHandler).not.toContain('setWorkbenchOpen(false)');
    expect(rendererSource).toContain('window.controlPanel.onNetworkPreflight((result) => {');
    expect(rendererMarkup).toContain('id="network-preflight-dialog"');
    expect(rendererMarkup).toContain('id="network-preflight-recheck"');
    expect(rendererSource).toMatch(
      /connectionTestInProgress = true;\s+renderConnectionTestPending\(\);\s+const knownState = claudeStates\.get\(status\.id\);[\s\S]*?renderClaudeState\(knownState\);/,
    );
    const testHandler = rendererSource.slice(
      rendererSource.indexOf('const runConnectionTest = async'),
      rendererSource.indexOf('const setWorkbenchOpen ='),
    );
    expect(testHandler).not.toContain('runGuarded(');
    expect(testHandler).toMatch(
      /finally \{\s+connectionTestInProgress = false;[\s\S]*?testClaudeConnectionButton\.setAttribute\('aria-busy', 'false'\);[\s\S]*?testClaudeConnectionButton\.textContent = originalLabel;[\s\S]*?syncConnectionInteractivity\(\);/,
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

  it('runs one real test for the active saved Claude connection on each app opening', () => {
    expect(rendererSource).toContain('const automaticConnectionTestSessions = new Set<string>();');
    expect(rendererSource).toMatch(
      /const scheduleAutomaticConnectionTest = \(state: ClaudeProjectState\): void => \{[\s\S]*?automaticConnectionTestSessions\.add\(state\.sessionId\);[\s\S]*?window\.setTimeout\(\(\) => \{[\s\S]*?runConnectionTest\(false, savedClaudeConfigInput\(currentState\.config\)\);/,
    );
    expect(rendererSource).toMatch(
      /renderActiveNetworkPreflight\(\);\s+scheduleAutomaticConnectionTest\(state\);/,
    );
    expect(rendererSource).toMatch(
      /const rerunAutomaticConnectionTestForActiveProject = \(\): void => \{[\s\S]*?automaticConnectionTestSessions\.delete\(state\.sessionId\);\s+scheduleAutomaticConnectionTest\(state\);/,
    );
    expect(rendererSource).toContain(
      'const unsubscribeAppWindowRestored = window.controlPanel.onAppWindowRestored(() => {',
    );
    expect(rendererSource).toContain('unsubscribeAppWindowRestored();');
    expect(rendererSource).toMatch(
      /if \(!provider \|\| networkPreflightInProgress\) \{\s+if \(!provider && force\) \{/,
    );
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

  it('always releases the model switch trigger after the IPC operation settles', () => {
    const switchHandler = rendererSource.slice(
      rendererSource.indexOf('const switchClaudeModel = async'),
      rendererSource.indexOf('const switchPermissionMode = async'),
    );
    expect(switchHandler).toMatch(
      /modelSwitchInProgress = true;\s+footerModel\.disabled = true;\s+footerModel\.setAttribute\('aria-busy', 'true'\);/,
    );
    expect(switchHandler).toMatch(
      /finally \{\s+endMask\(\);\s+modelSwitchInProgress = false;\s+footerModel\.disabled = false;\s+footerModel\.setAttribute\('aria-busy', 'false'\);/,
    );
    expect(switchHandler).toContain('renderClaudeState(knownState);');
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

  it('scrolls a folder’s full conversation history without moving the running rows', () => {
    // No truncation: every stored conversation is rendered into the dedicated scroller.
    expect(rendererSource).not.toContain('history.slice(0, 6)');
    expect(rendererSource).toMatch(
      /scroller\.className = 'project-folder__history';[\s\S]*?for \(const session of history\) \{\s+scroller\.append\(renderHistoryRow\(project\.path, session\)\);/,
    );
    // Scroll position survives the sidebar rebuild that every workspace tick performs.
    expect(rendererSource).toContain('historyScrollPositions.set(key, scroller.scrollTop);');
    expect(rendererSource).toContain('const savedScroll = historyScrollPositions.get(key) ?? 0;');
    expect(rendererStyles).toMatch(
      /\.project-folder__history \{[\s\S]*?max-height:[\s\S]*?overflow-y: auto;/,
    );
  });

  it('types Claude-generated titles in place and skips the animation for manual renames', () => {
    expect(rendererSource).toContain('const syncConversationTitles = (state: WorkspaceState)');
    expect(rendererSource).toMatch(
      /function renderWorkspace\(state: WorkspaceState\): void \{[\s\S]*?syncConversationTitles\(state\);/,
    );
    // The animation continues from the frame on screen when the sidebar is rebuilt mid-typing.
    expect(rendererSource).toContain('const chars = existing ? existing.chars : [...fromTitle];');
    expect(rendererSource).toContain('label.textContent = displayedConversationTitle(status);');
    // Manual renames land instantly; reduced motion opts out entirely.
    expect(rendererSource).toContain('suppressedTitleAnimations.add(status.id);');
    expect(rendererSource).toMatch(
      /suppressedTitleAnimations\.delete\(status\.id\) \|\|\s+window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/,
    );
    expect(rendererStyles).toContain("[data-title-typing='true']::after");
    expect(rendererStyles).toContain('@keyframes titleCaretBlink');
  });

  it('lets an in-use folder collapse to its running rows instead of pinning it open', () => {
    // Expansion is user state only — an active session must not force the folder open.
    expect(rendererSource).toContain('const expanded = expandedFolders.has(key);');
    expect(rendererSource).not.toContain('expandedFolders.has(key) || containsActive');
    // Collapsed while in use: running conversations stay, only the history section hides.
    expect(rendererSource).toMatch(/if \(!expanded && !showsRunning\) \{\s+return folder;\s+\}/);
    expect(rendererSource).toMatch(
      /body\.append\(renderConversationRow\(session\)\);\s+\}\s+if \(!expanded\) \{[\s\S]*?folder\.append\(body\);\s+return folder;/,
    );
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

  it('answers every quit request and only questions the ones that would lose work', () => {
    // The main process cancels its own quit and waits, so a path that fails to answer would make the
    // app impossible to close. All three branches must call confirmQuit.
    expect(rendererSource).toContain('window.controlPanel.onAppQuitRequested(() => {');
    expect(rendererSource).toContain('window.controlPanel.confirmQuit(true);');
    expect(rendererSource).toContain('window.controlPanel.confirmQuit(false);');
    expect(rendererSource).toContain('window.controlPanel.confirmQuit(confirmed);');
    expect(rendererSource).toMatch(
      /const streaming = Boolean\(activeChatRequestId\);[\s\S]*?if \(!streaming && !preparing\) \{\s+window\.controlPanel\.confirmQuit\(true\);/,
    );
    // A running terminal is the documented background state, so it must not trigger the prompt: the
    // decision is made from the chat in-flight flags alone.
    expect(rendererSource).toMatch(
      /const preparing = chatSubmissionInFlight \|\| queuedChatAttachmentImports > 0;/,
    );
    expect(rendererSource).toContain("title: '对话正在进行中',");
    expect(rendererSource).toContain('unsubscribeAppQuitRequested();');
  });

  it('gives every button a press response and no dead interaction states', () => {
    // The floor: one :active scale on the element itself, so a new button cannot ship without
    // feedback simply because nobody wrote a rule for its family.
    expect(rendererStyles).toMatch(
      /button:active:not\(:disabled\)\s*\{\s*transform: scale\(var\(--press-sm\)\);/,
    );
    // Row-shaped controls opt out: scaling a list row shifts its text against its neighbours.
    expect(rendererStyles).toMatch(
      /\.conversation-item__select:active:not\(:disabled\),[\s\S]*?\{\s*transform: none;/,
    );
    // The tint-button family used to have a background and no hover at all.
    expect(rendererStyles).toMatch(
      /\.router-actions button:hover:not\(:disabled\)[\s\S]*?\{[\s\S]*?var\(--accent-ring\)/,
    );
    // A press that references an undefined token silently does nothing, so no scale may name one.
    const pressTokens = rendererStyles.match(/scale\(var\((--[\w-]+)\)\)/g) ?? [];
    expect(pressTokens.length).toBeGreaterThan(0);
    for (const usage of pressTokens) {
      const token = /var\((--[\w-]+)\)/.exec(usage)?.[1] ?? '';
      expect(rendererStyles).toContain(`${token}:`);
    }
  });
});
