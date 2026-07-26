const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const sizes = [
  [820, 640],
  [900, 640],
  [1180, 760],
];

const inspectLayout = `
(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const selector = 'button, input, select, textarea, [role="separator"]';
  const controls = [...document.querySelectorAll(selector)].filter(
    (element) => visible(element) && !element.classList.contains('workbench-scrim'),
  );
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
    const left = controls[leftIndex];
    const leftRect = left.getBoundingClientRect();
    for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
      const right = controls[rightIndex];
      if (left.contains(right) || right.contains(left)) continue;
      const rightRect = right.getBoundingClientRect();
      const overlapWidth = Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left);
      const overlapHeight = Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top);
      if (overlapWidth > 1 && overlapHeight > 1) {
        overlaps.push([
          left.id || left.textContent.trim().slice(0, 24),
          right.id || right.textContent.trim().slice(0, 24),
        ]);
      }
    }
  }
  const overflow = [...document.querySelectorAll(
    '.control-panel, .rail-page--active, .terminal-toolbar, .terminal-footer, .plugin-toolbar, .install-source-row, .router-actions, .claude-workbench'
  )]
    .filter(visible)
    .filter((element) => element.scrollWidth > element.clientWidth + 2)
    .map((element) => element.id || element.className);
  return {
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    overlaps,
    overflow,
  };
})()
`;

const selectRailPage = (name) => `
  for (const page of document.querySelectorAll('[data-rail-page]')) {
    page.classList.toggle('rail-page--active', page.dataset.railPage === ${JSON.stringify(name)});
  }
`;

const selectWorkbenchPage = (name) => `
  document.querySelector('#claude-workbench').classList.add('claude-workbench--open');
  for (const page of document.querySelectorAll('[data-workbench-page]')) {
    page.classList.toggle('workbench-page--active', page.dataset.workbenchPage === ${JSON.stringify(name)});
  }
`;

app.whenReady().then(async () => {
  const results = [];
  const window = new BrowserWindow({
    height: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 820,
  });
  await window.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));

  for (const [width, height] of sizes) {
    window.setSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const page of ['projects', 'connection', 'plugins']) {
      await window.webContents.executeJavaScript(selectRailPage(page));
      const result = await window.webContents.executeJavaScript(inspectLayout);
      results.push({ height, page, width, ...result });
    }
    await window.webContents.executeJavaScript(selectRailPage('projects'));
    for (const page of ['session', 'commands', 'shortcuts']) {
      await window.webContents.executeJavaScript(selectWorkbenchPage(page));
      const result = await window.webContents.executeJavaScript(inspectLayout);
      results.push({ height, page: `workbench:${page}`, width, ...result });
    }
    await window.webContents.executeJavaScript(
      `document.querySelector('#claude-workbench').classList.remove('claude-workbench--open')`,
    );
  }

  const failures = results.filter(
    (result) => result.documentOverflow || result.overlaps.length > 0 || result.overflow.length > 0,
  );
  console.log(JSON.stringify({ failures, sizes: results.length }, null, 2));
  app.exit(failures.length === 0 ? 0 : 1);
});
