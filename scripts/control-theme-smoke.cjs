/*
 * Finds controls still painted by the Chromium user-agent stylesheet instead of the ClaudeDock
 * theme. No themed rule in styles.css uses `border-style: outset`, so a button that still computes
 * `outset` has never been matched by a project selector and renders as a native Windows button.
 *
 * Usage: electron scripts/control-theme-smoke.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-control-theme-smoke'));

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
  await window.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  const report = await window.webContents.executeJavaScript(inspectControls);
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.unthemed.length === 0 ? 0 : 1);
});
