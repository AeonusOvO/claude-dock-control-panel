const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const outputDirectory = path.join(__dirname, '..', 'dist', 'visual-qa');
app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-visual-smoke'));

const activateRailPage = (name) => `
  for (const page of document.querySelectorAll('[data-rail-page]')) {
    page.classList.toggle('rail-page--active', page.dataset.railPage === ${JSON.stringify(name)});
  }
`;

app.whenReady().then(async () => {
  mkdirSync(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    height: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 820,
  });
  await window.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));

  await window.webContents.executeJavaScript(activateRailPage('plugins'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'plugins-820.png'),
    (await window.capturePage()).toPNG(),
  );

  window.setSize(1000, 720);
  await window.webContents.executeJavaScript(`
    ${activateRailPage('projects')}
    document.querySelector('#conversation-rename-input').value = '终端主题与中文输入修复';
    document.querySelector('#conversation-rename-dialog').showModal();
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'rename-theme-1000.png'),
    (await window.capturePage()).toPNG(),
  );

  console.log(outputDirectory);
  app.exit(0);
});
