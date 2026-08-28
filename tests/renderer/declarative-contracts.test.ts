import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORT_OPTIONS,
  isClaudeEffortSafeAfterThinkingDisabledError,
} from '../../src/shared/claude/effort';
import { CLAUDE_PROVIDERS } from '../../src/shared/claude/providers';
import { routerCapabilityFor } from '../../src/shared/router/capabilities';
import { deriveUpdateActionState } from '../../src/shared/ui/update-actions';
import { rendererStyles } from '../helpers/renderer-css';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';
import { expectCss } from '../helpers/renderer-interaction-fixture';

describe('exported behavior and declarative UI contracts', () => {
  let harness: RendererHarness;

  beforeAll(async () => {
    harness = await createRendererHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('offers a project-scoped official Codex preparation path without hiding its safety boundary', () => {
    expect(harness.query('#runtime-claude')).toBeInstanceOf(HTMLInputElement);
    expect(harness.query('#runtime-codex')).toBeInstanceOf(HTMLInputElement);
    expect(harness.query('#codex-install-step').textContent).toContain('安装');
    expect(harness.query('#codex-project-step').textContent).toContain('当前目录');
  });

  it('uses authoritative local runtime marks and removes the redundant session-status card', () => {
    const picker = harness.query('#runtime-picker');
    expect(picker.querySelectorAll('.runtime-option')).toHaveLength(2);
    expect(harness.document.querySelector('#status-pill')).toBeNull();
    expect(picker.querySelectorAll('.runtime-option__icon')).toHaveLength(2);
    expect(picker.querySelector('.runtime-option__icon svg')).toBeNull();
    expect(
      Array.from(picker.querySelectorAll<HTMLImageElement>('.runtime-option__brand-mark'), (mark) =>
        mark.getAttribute('src'),
      ),
    ).toEqual([
      './assets/brands/claude-spark-clay.svg',
      './assets/brands/openai-blossom-black.svg',
      './assets/brands/openai-blossom-white.svg',
    ]);
    expectCss(
      /\.runtime-option__icon--claude\s*\{[^}]*background:\s*var\(--brand-anthropic-surface\)/u,
    );
    expectCss(
      /\.runtime-option__icon--codex\s*\{[^}]*background:\s*var\(--brand-openai-light-surface\)/u,
    );
    expectCss(
      /html\[data-appearance='dark'\] \.runtime-option__icon--codex\s*\{[^}]*var\(--brand-openai-dark-surface\)/u,
    );
    for (const declaration of [
      '--brand-anthropic-surface: #faf9f5',
      '--brand-openai-light-surface: #ffffff',
      '--brand-openai-dark-surface: #000000',
    ]) {
      expect(rendererStyles).toContain(declaration);
    }
    expect(rendererStyles).not.toMatch(/\.runtime-option__brand-mark\s*\{[^}]*filter:/u);
  });

  it('keeps confirmation and IME focus inside the renderer across window activation', () => {
    expect(harness.document.querySelectorAll('dialog.popover')).toHaveLength(14);
    expect(harness.query('#confirmation-dialog').getAttribute('aria-labelledby')).toBe(
      'confirmation-dialog-title',
    );
    expect(harness.query('#confirmation-dialog form').getAttribute('method')).toBe('dialog');
  });

  it('reuses the shared transient-surface motion recipe instead of one-off keyframes', () => {
    expectCss(/@keyframes popover-in/u);
    expectCss(/@keyframes popover-out/u);
    expectCss(/\.rail-page--active\s*\{[^}]*animation:\s*popover-in/u);
    expect(rendererStyles).not.toMatch(/@keyframes (?:railPageEnter|runtimeSummaryEnter)/u);
  });

  it('presents ChatGPT subscription routing as a ClaudeDock-managed flow', () => {
    const provider = CLAUDE_PROVIDERS.find(({ id }) => id === 'chatgpt-subscription');
    expect(provider).toMatchObject({ baseUrl: 'http://127.0.0.1:8317', group: 'subscription' });
    expect(provider?.label).toContain('ClaudeDock 托管');
    expect(provider?.caveat).toContain('第三方开源网关');
  });

  it('decides whether CCR is required without asking the user to configure routing', () => {
    expect(routerCapabilityFor('deepseek').mode).toBe('direct');
    expect(routerCapabilityFor('custom').mode).toBe('router-optional');
    expect(harness.query<HTMLInputElement>('#router-wizard-use-route').disabled).toBe(true);
  });

  it('opens global settings from the bottom rail and keeps advanced connection tools categorized', () => {
    const tabs = Array.from(
      harness.document.querySelectorAll<HTMLElement>('[data-settings-tab]'),
      ({ dataset }) => dataset.settingsTab,
    );
    expect(tabs).toEqual([
      'general',
      'network',
      'advanced',
      'claude-execution',
      'connection',
      'proxy',
      'router',
    ]);
    expect(harness.query('#open-connection-advanced').getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('keeps saved gateway and model history in the main flow before model configuration', () => {
    const history = harness.query('#connection-history');
    const config = harness.query('#claude-config-form');
    expect(history.compareDocumentPosition(config) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(config.textContent).toContain('小型/备用模型标识');
    expect(harness.query('#open-connection-history').getAttribute('aria-haspopup')).toBe('dialog');
    expect(harness.query('#connection-history-dialog')).toBeInstanceOf(HTMLDialogElement);
    expect(harness.document.querySelectorAll('#connection-history-tabs [role="tab"]')).toHaveLength(
      4,
    );
  });

  it('labels connection protocol and route while supporting contextual renaming', () => {
    expect(harness.query('#claude-protocol').textContent).toContain('OpenAI');
    expect(harness.query('[data-history-context-action="rename"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(harness.query('#conversation-rename-field-label').textContent).toContain('名称');
  });

  it('keeps the connection chooser spacious and floats complete actions in a themed glass capsule', () => {
    expect(harness.query('#connection-wizard-previous').textContent).toContain('上一步');
    expect(harness.query('#connection-wizard-next').textContent).toContain('下一步');
    expectCss(/\.connection-wizard-viewport\s*\{[^}]*overflow:\s*visible/u);
    expectCss(
      /\.connection-wizard-actions\s*\{[^}]*backdrop-filter:\s*blur\(var\(--mask-blur\)\) saturate\(125%\)[^}]*border-radius:\s*var\(--r-pill\)[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto[^}]*position:\s*sticky/u,
    );
    expectCss(
      /\.connection-wizard-actions \.button\s*\{[^}]*border-radius:\s*var\(--r-pill\)[^}]*min-height:\s*var\(--control-h-md\)/u,
    );
    expectCss(
      /\.access-choice-card\s*\{[^}]*min-height:\s*clamp\(128px, 13vh, 152px\)[^}]*padding:\s*clamp\(/u,
    );
    expectCss(
      /\.provider-picker\s*\{[^}]*display:\s*grid;[^}]*gap:\s*clamp\(var\(--s-5\), 3vw, var\(--s-8\)\)/u,
    );
    expect(rendererStyles).not.toMatch(
      /@media \(max-width: 1024px\)\s*\{[^}]*\.connection-wizard-actions\s*\{[^}]*position:\s*relative/u,
    );
  });

  it('provides independently configured model chat with a separate workspace', () => {
    expect(harness.query('#chat-config-form')).toBeInstanceOf(HTMLFormElement);
    expect(harness.query('#chat-shell').hasAttribute('hidden')).toBe(true);
    expect(harness.query('#chat-composer')).toBeInstanceOf(HTMLFormElement);
  });

  it('places the workspace first and exposes the complete independent-conversation state', () => {
    const buttons = Array.from(harness.document.querySelectorAll<HTMLElement>('[data-rail-tab]'));
    expect(buttons.map(({ dataset }) => dataset.railTab).slice(0, 3)).toEqual([
      'projects',
      'chat',
      'connection',
    ]);
    for (const id of ['chat-context-total', 'chat-token-usage', 'new-chat', 'chat-history-list']) {
      expect(harness.document.getElementById(id)).not.toBeNull();
    }
  });

  it('focuses the chat composer from navigation and uses the active theme for its focus animation', () => {
    expectCss(
      /\.terminal-composer textarea:focus,\s*\.chat-composer textarea:focus\s*\{[^}]*composerFocusIn/u,
    );
    expectCss(/@keyframes composerFocusIn/u);
    expect(rendererStyles).not.toContain('chatComposerFocusIn');
  });

  it('gives chat history the full rail and keeps artifact details compact and structured', () => {
    expect(harness.query('.artifact-details__intro')).toBeInstanceOf(HTMLElement);
    expect(harness.query('.artifact-details__section-heading')).toBeInstanceOf(HTMLElement);
    expectCss(/\.chat-history__list\s*\{[^}]*overflow-y:\s*auto/u);
  });

  it('uses theme-aware typography and glow feedback without hover lift', () => {
    for (const token of ['--ease-standard', '--dur-4', '--r-md', '--lh-prose']) {
      expect(rendererStyles).toContain(`${token}:`);
    }
    expect(rendererStyles).not.toMatch(/:hover[^{]*\{[^}]*translateY\(/su);
  });

  it('checks all update sources after first paint and only reveals detected update actions', () => {
    expect(deriveUpdateActionState(undefined, undefined)).toEqual({
      application: false,
      claudeCode: 'hidden',
      plugins: false,
      router: 'hidden',
      totalAvailable: 0,
    });
    for (const id of ['install-update-claude', 'install-router', 'update-all-plugins']) {
      expect(harness.query(`#${id}`).hasAttribute('hidden')).toBe(true);
    }
  });

  it('stages non-immediate settings and never persists the fallback theme during first paint', () => {
    expect(harness.query('#settings-unsaved-indicator').hasAttribute('hidden')).toBe(true);
    expect(harness.method('setAppTheme')).not.toHaveBeenCalled();
  });

  it('separates requested Claude windows from fresh runtime evidence', () => {
    expect(harness.query('#claude-context-window-status').textContent).toContain('自动模式');
    expect(
      harness.document.querySelector('[data-claude-context-window-mode="auto"]'),
    ).not.toBeNull();
    expect(
      harness.document.querySelector('[data-claude-context-window-mode="extended"]'),
    ).not.toBeNull();
  });

  it('offers every adjustable effort level and applies it without a relaunch', () => {
    expect(CLAUDE_EFFORT_OPTIONS.map(({ id }) => id)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
    expect(CLAUDE_EFFORT_OPTIONS.filter(({ persists }) => !persists).map(({ id }) => id)).toEqual([
      'max',
      'ultracode',
    ]);
    expect(isClaudeEffortSafeAfterThinkingDisabledError('high')).toBe(true);
    expect(isClaudeEffortSafeAfterThinkingDisabledError('xhigh')).toBe(false);
  });

  it('keeps model, permission, and effort controls in the footer instead of above the composer', () => {
    const footer = harness.query('.terminal-footer');
    for (const id of ['footer-model', 'footer-mode', 'footer-effort']) {
      expect(footer.contains(harness.query(`#${id}`))).toBe(true);
    }
    expect(harness.document.querySelector('#composer-control-strip')).toBeNull();
  });

  it('scrolls a folder’s full conversation history without moving the running rows', () => {
    expectCss(/\.project-folder__history\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/u);
    expectCss(/\.history-item\s*\{[^}]*min-height:\s*27px/u);
  });

  it('lets an in-use folder collapse to its running rows instead of pinning it open', () => {
    expect(
      harness.query('#project-list').querySelectorAll('.project-folder__history'),
    ).toHaveLength(0);
    expect(harness.query('#project-list').querySelectorAll('.conversation-item')).toHaveLength(0);
  });

  it('gives every button a press response and no dead interaction states', () => {
    expectCss(/button:active:not\(:disabled\)\s*\{\s*transform:\s*scale\(var\(--press-sm\)\)/u);
    for (const token of rendererStyles.matchAll(/scale\(var\((--[\w-]+)\)\)/gu)) {
      expect(rendererStyles).toContain(`${token[1]}:`);
    }
  });

  it('answers hover and press on the trigger through the shell', () => {
    expectCss(/\.select:not\(\[data-disabled='true'\]\):hover \.select__trigger/u);
    expectCss(
      /\.select:not\(\[data-disabled='true'\]\):active \.select__trigger\s*\{[^}]*--press-sm/u,
    );
  });

  it('lands the card entrance on the resting opacity rather than a hard 1', () => {
    expectCss(
      /\.plugin-card\s*\{[^}]*--card-rest-opacity:\s*1[^}]*opacity:\s*var\(--card-rest-opacity\)/u,
    );
    expectCss(
      /@keyframes pluginCardEnter\s*\{[\s\S]*?to\s*\{\s*opacity:\s*var\(--card-rest-opacity\)/u,
    );
  });

  it('paints the MCP toolbar refresh button with the shared plugin-toolbar treatment', () => {
    expect(harness.query('#mcp-refresh').closest('.plugin-toolbar')).not.toBeNull();
    expectCss(/\.plugin-toolbar button\s*\{[^}]*background:\s*var\(--surface-3\)/u);
  });

  it('gives .dialog-primary its own paint outside dialog footers', () => {
    expect(harness.query('#router-wizard-submit').classList.contains('dialog-primary')).toBe(true);
    expectCss(/\.dialog-primary\s*\{[^}]*background:\s*var\(--accent-tint\)/u);
  });

  it('never lets the conversation scrollers grow a horizontal scrollbar', () => {
    expectCss(/\.project-list\s*\{[^}]*overflow-x:\s*hidden/u);
    expectCss(/\.project-folder__history\s*\{[^}]*overflow-x:\s*hidden/u);
  });

  it('crossfades the timestamp into a delete button without reflowing the row', () => {
    expectCss(/\.history-item__delete\s*\{[^}]*opacity:\s*0[^}]*position:\s*absolute/u);
    expectCss(/\.history-item:hover \.history-item__delete[^{]*\{\s*opacity:\s*1/u);
  });

  it('runs every hover reveal inside the 150-200ms band', () => {
    expect(rendererStyles).toContain(
      '--dur-hover: clamp(150ms, calc(var(--dur-micro) * 1.35), 200ms);',
    );
    expect(rendererStyles).toContain('--dur-instant: 0.01ms;');
  });

  it('keeps the delete button clear of the vertical scrollbar in every history scroller', () => {
    expectCss(/\.history-item__delete\s*\{[^}]*right:\s*var\(--s-1-5\)/u);
    expectCss(/\.project-folder__history\s*\{[^}]*scrollbar-gutter:\s*stable/u);
    expectCss(/\.chat-history__list\s*\{[^}]*padding-right:\s*var\(--s-2\)/u);
  });

  it('uses one button base with semantic and size variants', () => {
    expect(rendererStyles).toContain('.button--compact');
    expect(rendererStyles).toContain('.button--danger');
    expect(harness.document.querySelector('.ui-button')).toBeNull();
  });

  it('keeps the advanced terminal action in the shared icon-button family', () => {
    expect(harness.query('#native-terminal-toggle').classList.contains('icon-button')).toBe(true);
    expect(harness.query('#native-terminal-toggle-label').textContent).toBe('原生对话');
    expect(harness.document.querySelector('#native-model-status')).toBeNull();
  });

  it('uses one shared toolbar menu component for workbench and theme selection', () => {
    const workbench = harness.query('#workbench-trigger');
    const theme = harness.query('#terminal-theme');
    expect(workbench.classList.contains('toolbar-menu-button')).toBe(true);
    expect(theme.closest('.select')).not.toBeNull();
    expect(
      workbench.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps one composer behavior while giving Claude and Telegram distinct shells', () => {
    expect(harness.document.querySelector('.native-composer__send-icon--claude')).not.toBeNull();
    expect(harness.document.querySelector('.native-composer__send-icon--telegram')).not.toBeNull();
    expectCss(/\[data-theme='telegram'\] \.native-composer__row\s*\{[^}]*border-radius:\s*0/u);
  });

  it('parks queued text above the send row instead of promoting it to a bubble', () => {
    const queued = harness.query('#native-queued');
    const row = harness.query('.native-composer__row');
    expect(queued.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queued.querySelector('.native-message')).toBeNull();
    expectCss(/\.native-queued\s*\{[^}]*border:\s*1px dashed/u);
  });

  it('keeps the collapsed native Ultra control concise and moves details to its description', () => {
    expect(CLAUDE_EFFORT_OPTIONS.find(({ id }) => id === 'ultracode')?.label).toBe('Ultra Code');
    expect(CLAUDE_EFFORT_OPTIONS.find(({ id }) => id === 'ultracode')?.detail).toContain(
      '工作流编排',
    );
  });

  it('renders the conversation summary as one compact four-level inspector', () => {
    expect(harness.query('#runtime-activity-panel').textContent).toContain('运行概览');
    for (const heading of ['环境', '活动', '来源']) {
      expect(harness.query('#runtime-activity-panel').textContent).toContain(heading);
    }
  });

  it('uses tokenized entry and exit motion for the summary and its rows', () => {
    expectCss(/\.runtime-activity-panel\[data-state='opening'\],[^{]*\{[^}]*popover-in/u);
    expectCss(/\.runtime-activity-panel\[data-state='closing'\]\s*\{[^}]*popover-out/u);
    expectCss(/\.runtime-summary-row[^{]*\{[^}]*runtimeSummaryRowEnter/u);
  });
});
