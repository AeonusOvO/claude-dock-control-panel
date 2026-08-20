/*
 * Finds controls still painted by the Chromium user-agent stylesheet instead of the ClaudeDock
 * theme. No themed rule in styles.css uses `border-style: outset`, so a button that still computes
 * `outset` has never been matched by a project selector and renders as a native Windows button.
 *
 * Usage: electron scripts/smoke/control-theme-smoke.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const typescript = require('typescript');

app.setPath('userData', path.join(__dirname, '..', '..', 'dist', '.electron-control-theme-smoke'));

const loadThemeDefinitions = () => {
  const source = readFileSync(
    path.join(__dirname, '..', '..', 'src', 'shared', 'ui', 'terminal-themes.ts'),
    'utf8',
  );
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const themeModule = { exports: {} };
  const factory = new vm.Script(
    `(function (exports, module) { ${transpiled}\n})`,
  ).runInThisContext();
  factory(themeModule.exports, themeModule);
  return themeModule.exports;
};

const { SHELL_CSS_VARIABLES, TERMINAL_THEMES } = loadThemeDefinitions();

const inspectControls = `
(() => {
  const describe = (element) => {
    const style = getComputedStyle(element);
    return {
      id: element.id || null,
      className: element.className || null,
      text: (element.textContent || '').trim().slice(0, 28),
      parent: element.parentElement
        ? element.parentElement.className || element.parentElement.tagName.toLowerCase()
        : null,
      background: style.backgroundColor,
      borderStyle: style.borderTopStyle,
    };
  };
  const unthemed = [...document.querySelectorAll('button, input[type="button"], input[type="submit"]')]
    .map(describe)
    .filter((entry) => entry.borderStyle === 'outset');
  return { total: document.querySelectorAll('button').length, unthemed };
})()
`;

app.whenReady().then(async () => {
  ipcMain.handle('busy:set-conversation', () => []);
  ipcMain.handle('download:list', () => []);
  ipcMain.handle('application-proxy:get', () => ({
    config: {
      enabled: false,
      host: '',
      passwordConfigured: false,
      protocol: 'http',
      scope: { application: false, cli: true, conversation: false },
      username: '',
    },
  }));
  ipcMain.handle('app:get-settings', () => ({
    advanced: { chatIdleTimeoutMinutes: 0, webResearchIsolation: false },
    closeBehavior: 'tray',
    language: 'zh-CN',
    launchAtLogin: false,
    theme: 'claude',
    version: 'control-theme-smoke',
  }));
  ipcMain.handle('ui:set-theme', () => undefined);
  ipcMain.handle('workspace:get-state', () => ({
    activeSessionId: '',
    projects: [],
    sessions: [],
  }));

  const window = new BrowserWindow({
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    width: 1280,
  });
  await window.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  const report = await window.webContents.executeJavaScript(inspectControls);
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('DOM.enable');
  await window.webContents.debugger.sendCommand('CSS.enable');
  const documentNode = await window.webContents.debugger.sendCommand('DOM.getDocument');
  const hoverSelectors = ['#launch-new', '#run-claude'];
  const hoverNodes = new Map();
  for (const selector of hoverSelectors) {
    const node = await window.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector,
    });
    hoverNodes.set(selector, node.nodeId);
  }
  const hoverFailures = [];
  for (const [themeId, definition] of Object.entries(TERMINAL_THEMES)) {
    for (const selector of hoverSelectors) {
      const expected = await window.webContents.executeJavaScript(`
        (() => {
          const definition = ${JSON.stringify(definition)};
          const mapping = ${JSON.stringify(SHELL_CSS_VARIABLES)};
          for (const [field, property] of Object.entries(mapping)) {
            document.documentElement.style.setProperty(property, definition.shell[field]);
          }
          document.documentElement.dataset.theme = ${JSON.stringify(themeId)};
          const button = document.querySelector(${JSON.stringify(selector)});
          button.disabled = false;
          button.style.setProperty('transition', 'none', 'important');
          const normalize = (color) => {
            const probe = document.createElement('i');
            probe.style.backgroundColor = color;
            document.body.append(probe);
            const normalized = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return normalized;
          };
          return {
            base: getComputedStyle(button).backgroundColor,
            expectedBase: normalize(definition.shell.accentSolid),
            expectedHover: normalize(definition.shell.accentSolidHover),
          };
        })()
      `);
      const nodeId = hoverNodes.get(selector);
      await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
        forcedPseudoClasses: ['hover'],
        nodeId,
      });
      const hover = await window.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`,
      );
      await window.webContents.debugger.sendCommand('CSS.forcePseudoState', {
        forcedPseudoClasses: [],
        nodeId,
      });
      if (
        expected.base !== expected.expectedBase ||
        hover !== expected.expectedHover ||
        hover === expected.base
      ) {
        hoverFailures.push({ ...expected, hover, selector, themeId });
      }
    }
  }
  window.webContents.debugger.detach();
  report.hoverFailures = hoverFailures;
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.unthemed.length === 0 && hoverFailures.length === 0 ? 0 : 1);
});
