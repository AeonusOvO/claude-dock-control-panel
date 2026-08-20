import katex from 'katex';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  SHELL_CSS_VARIABLES,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../../shared/ui/terminal-themes';
import { setEnhancedSelectValue } from '../platform/components';
import {
  createKatexMathRenderer,
  createMarkdownRenderer,
  type MarkdownDomRenderer,
} from '../platform/markdown';
import { requiredElement } from '../platform/dom';
import type { TerminalView } from '../features/terminal/state';

export interface ThemeShellDeps {
  onHighlighterReady: () => void;
  onRunArtifact: (html: string, mount: HTMLElement) => Promise<void>;
  onSettingsThemeChanged: () => void;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export interface ThemeShell {
  applySettingsThemeSelect: (theme: string) => void;
  applyTerminalTheme: (themeId: TerminalThemeId, announce?: boolean, persist?: boolean) => void;
  dispose: () => void;
  getActiveTerminalTheme: () => TerminalThemeId;
  getMarkdownRenderer: () => MarkdownDomRenderer;
  getSettingsThemeValue: () => string;
  setArtifactThemeUpdateHandler: (handler: () => void) => void;
  setTerminalViewsProvider: (provider: () => Map<string, TerminalView>) => void;
  terminalThemeSelect: HTMLSelectElement;
}

export const createThemeShell = (deps: ThemeShellDeps): ThemeShell => {
  const terminalThemeSelect = requiredElement<HTMLSelectElement>('#terminal-theme');
  const settingsTheme = requiredElement<HTMLSelectElement>('#settings-theme');
  let markdownRenderer: MarkdownDomRenderer;
  let markdownHighlighter: HighlighterCore | undefined;
  const storedTerminalTheme = localStorage.getItem('claudedock.terminalTheme');
  let activeTerminalTheme: TerminalThemeId = isTerminalThemeId(storedTerminalTheme)
    ? storedTerminalTheme
    : DEFAULT_TERMINAL_THEME;
  terminalThemeSelect.value = activeTerminalTheme;

  const rebuildMarkdownRenderer = (): void => {
    const loadedLanguages = new Set(markdownHighlighter?.getLoadedLanguages() ?? []);
    markdownRenderer = createMarkdownRenderer({
      highlighter: markdownHighlighter
        ? {
            codeToTokens: (code, options) =>
              markdownHighlighter?.codeToTokens(code, {
                lang: (loadedLanguages.has(options.lang) ? options.lang : 'text') as never,
                theme:
                  TERMINAL_THEMES[activeTerminalTheme].appearance === 'dark'
                    ? 'github-dark'
                    : 'github-light',
              }),
          }
        : undefined,
      mathRenderer: createKatexMathRenderer(katex),
      onOpenExternal: async (url) => {
        await window.controlPanel.openMarkdownExternal(url);
      },
      onRunArtifact: async (html, mount) => {
        await deps.onRunArtifact(html, mount);
      },
      writeClipboardText: async (text) => {
        await window.controlPanel.writeClipboardText(text);
      },
    });
  };

  rebuildMarkdownRenderer();
  void createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    langs: [
      import('@shikijs/langs/bash'),
      import('@shikijs/langs/css'),
      import('@shikijs/langs/html'),
      import('@shikijs/langs/javascript'),
      import('@shikijs/langs/json'),
      import('@shikijs/langs/markdown'),
      import('@shikijs/langs/powershell'),
      import('@shikijs/langs/python'),
      import('@shikijs/langs/typescript'),
    ],
    themes: [import('@shikijs/themes/github-dark'), import('@shikijs/themes/github-light')],
  })
    .then((highlighter) => {
      markdownHighlighter = highlighter;
      rebuildMarkdownRenderer();
      deps.onHighlighterReady();
    })
    .catch(() => {
      // Rich Markdown remains safe and readable; only syntax colours are unavailable.
    });

  const artifactThemeUpdateDelegate: { current: () => void } = { current: () => {} };
  const activeTerminalViews: { current: () => Map<string, TerminalView> } = {
    current: () => new Map(),
  };
  const applyTerminalTheme = (themeId: TerminalThemeId, announce = true, persist = true): void => {
    activeTerminalTheme = themeId;
    setEnhancedSelectValue(terminalThemeSelect, themeId);
    setEnhancedSelectValue(settingsTheme, themeId);
    if (persist) localStorage.setItem('claudedock.terminalTheme', themeId);
    const definition = TERMINAL_THEMES[themeId];
    // The shell steps are written onto the root element so every `var(--…)` in styles.css follows the
    // theme; without this the terminal recolours but the frame around it stays graphite.
    for (const [field, property] of Object.entries(SHELL_CSS_VARIABLES)) {
      document.documentElement.style.setProperty(
        property,
        definition.shell[field as keyof typeof definition.shell],
      );
    }
    document.documentElement.dataset.theme = themeId;
    document.documentElement.dataset.appearance = definition.appearance;
    document.documentElement.style.colorScheme = definition.appearance;
    document.documentElement.style.setProperty('--syntax-red', definition.palette.red);
    document.documentElement.style.setProperty('--syntax-blue', definition.palette.blue);
    document.documentElement.style.setProperty('--syntax-cyan', definition.palette.cyan);
    document.documentElement.style.setProperty('--syntax-green', definition.palette.green);
    document.documentElement.style.setProperty('--syntax-magenta', definition.palette.magenta);
    document.documentElement.style.setProperty('--syntax-yellow', definition.palette.yellow);
    document.documentElement.style.setProperty('--syntax-neutral', definition.palette.brightBlack);
    for (const view of activeTerminalViews.current().values()) {
      view.terminal.options.theme = { ...definition.palette };
      if (view.terminal.rows > 0) {
        view.terminal.refresh(0, view.terminal.rows - 1);
      }
    }
    // The native titlebar and window background live outside the document and need the main process.
    if (persist) {
      void window.controlPanel.setAppTheme(themeId).catch(() => {
        // A repaint failure is cosmetic only; the CSS side has already switched.
      });
    }
    if (announce) {
      deps.showToast(`主题已切换为“${definition.label}”`);
    }
    rebuildMarkdownRenderer();
    artifactThemeUpdateDelegate.current();
  };

  applyTerminalTheme(activeTerminalTheme, false, false);

  terminalThemeSelect.addEventListener('change', () => {
    const themeId = terminalThemeSelect.value;
    if (isTerminalThemeId(themeId)) {
      applyTerminalTheme(themeId);
    }
  });
  settingsTheme.addEventListener('change', () => {
    const themeId = settingsTheme.value;
    if (isTerminalThemeId(themeId)) {
      applyTerminalTheme(themeId, false, false);
    }
    deps.onSettingsThemeChanged();
  });

  return {
    applySettingsThemeSelect: (theme) => setEnhancedSelectValue(settingsTheme, theme),
    applyTerminalTheme,
    dispose: () => markdownHighlighter?.dispose(),
    getActiveTerminalTheme: () => activeTerminalTheme,
    getMarkdownRenderer: () => markdownRenderer,
    getSettingsThemeValue: () => settingsTheme.value,
    setArtifactThemeUpdateHandler: (handler) => {
      artifactThemeUpdateDelegate.current = handler;
    },
    setTerminalViewsProvider: (provider) => {
      activeTerminalViews.current = provider;
    },
    terminalThemeSelect,
  };
};
