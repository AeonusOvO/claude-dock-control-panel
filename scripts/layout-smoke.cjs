const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-layout-smoke'));

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
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (
        /auto|clip|hidden|scroll/.test(ancestorStyle.overflowX) &&
        (centerX < ancestorRect.left || centerX > ancestorRect.right)
      ) {
        return false;
      }
      if (
        /auto|clip|hidden|scroll/.test(ancestorStyle.overflowY) &&
        (centerY < ancestorRect.top || centerY > ancestorRect.bottom)
      ) {
        return false;
      }
    }
    return true;
  };
  const openDialog = document.querySelector('dialog[open]');
  const inspectionRoot = openDialog || document;
  const selector = 'button, input, select, textarea, [role="separator"]';
  const controls = [...inspectionRoot.querySelectorAll(selector)].filter(
    (element) => visible(element) && !element.classList.contains('workbench-scrim'),
  );
  const hitTargetMisses = controls
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
    })
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return !hit || !element.contains(hit);
    })
    .map((element) => element.id || element.textContent.trim().slice(0, 24));
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
  const overflow = [...inspectionRoot.querySelectorAll(
    '.control-panel, .rail-page--active, .terminal-toolbar, .terminal-footer, .plugin-toolbar, .plugin-tabs, .plugin-panel--active, .plugin-list, .plugin-card, .plugin-card__header, .plugin-card__actions, #plugin-marketplace-form, .install-source-row, .router-actions, .claude-workbench, .connection-advanced-dialog__shell, #connection-advanced-content'
  )]
    .filter(visible)
    .filter((element) => element.scrollWidth > element.clientWidth + 2)
    .map((element) => element.id || element.className);

  // The composer is the primary input; the footer and the workbench drawer must never sit on top of
  // it. The generic overlap sweep above misses this because neither is a focusable control.
  const covered = [];
  const composer = document.querySelector('#terminal-composer');
  if (composer && visible(composer)) {
    const composerRect = composer.getBoundingClientRect();
    for (const selector of ['.terminal-footer', '.claude-workbench--open']) {
      const other = document.querySelector(selector);
      if (!other || !visible(other)) continue;
      const otherRect = other.getBoundingClientRect();
      const overlapWidth = Math.min(composerRect.right, otherRect.right) - Math.max(composerRect.left, otherRect.left);
      const overlapHeight = Math.min(composerRect.bottom, otherRect.bottom) - Math.max(composerRect.top, otherRect.top);
      if (overlapWidth > 1 && overlapHeight > 1) {
        covered.push(selector);
      }
    }
  }

  return {
    covered,
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    hitTargetMisses,
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

const selectPluginPage = (name) => `
  for (const tab of document.querySelectorAll('[data-plugin-tab]')) {
    tab.classList.toggle('plugin-tab--active', tab.dataset.pluginTab === ${JSON.stringify(name)});
  }
  for (const panel of document.querySelectorAll('[data-plugin-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.pluginPanel === ${JSON.stringify(name)});
  }
`;

const addPluginStressFixtures = `
  (() => {
    const makeButton = (label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      return button;
    };
    const installedList = document.querySelector('#plugin-installed-list');
    installedList.replaceChildren();
    const installedCard = document.createElement('article');
    installedCard.className = 'plugin-card';
    installedCard.dataset.enabled = 'true';
    const installedHeader = document.createElement('div');
    installedHeader.className = 'plugin-card__header';
    const installedTitle = document.createElement('strong');
    installedTitle.textContent =
      'extremely-long-plugin-name-that-must-wrap-without-defining-a-minimum-card-width';
    const installedBadge = document.createElement('span');
    installedBadge.className = 'plugin-card__badge';
    installedBadge.textContent = '可更新';
    installedHeader.append(installedTitle, installedBadge);
    const installedDescription = document.createElement('p');
    installedDescription.textContent =
      '用于验证最窄侧栏下的长插件说明、默认操作和更新操作都不会互相遮挡。';
    const installedSource = document.createElement('code');
    installedSource.textContent =
      'https://example.com/an/intentionally/very/long/plugin/source/without/a/short/display/name';
    const installedActions = document.createElement('div');
    installedActions.className = 'plugin-card__actions';
    installedActions.append(makeButton('停用'), makeButton('更新'), makeButton('卸载'));
    installedCard.append(installedHeader, installedDescription, installedSource, installedActions);
    installedList.append(installedCard);

    const marketplaceList = document.querySelector('#plugin-marketplace-list');
    marketplaceList.replaceChildren();
    const marketplaceCard = document.createElement('article');
    marketplaceCard.className = 'plugin-card plugin-card--marketplace';
    const marketplaceHeader = document.createElement('div');
    marketplaceHeader.className = 'plugin-card__header';
    const marketplaceTitle = document.createElement('strong');
    marketplaceTitle.textContent =
      'marketplace-with-a-name-that-is-longer-than-the-narrow-plugin-panel';
    marketplaceHeader.append(marketplaceTitle);
    const marketplaceSource = document.createElement('code');
    marketplaceSource.textContent =
      'https://example.com/a/marketplace/repository/path/that/must/wrap/instead/of/overflow';
    const marketplaceActions = document.createElement('div');
    marketplaceActions.className = 'plugin-card__actions';
    marketplaceActions.append(makeButton('移除市场'));
    marketplaceCard.append(marketplaceHeader, marketplaceSource, marketplaceActions);
    marketplaceList.append(marketplaceCard);
  })()
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
    for (const page of ['projects', 'connection']) {
      await window.webContents.executeJavaScript(selectRailPage(page));
      const result = await window.webContents.executeJavaScript(inspectLayout);
      results.push({ height, page, width, ...result });
    }
    await window.webContents.executeJavaScript(selectRailPage('plugins'));
    await window.webContents.executeJavaScript(addPluginStressFixtures);
    for (const page of ['installed', 'available', 'marketplaces']) {
      await window.webContents.executeJavaScript(selectPluginPage(page));
      const result = await window.webContents.executeJavaScript(inspectLayout);
      results.push({ height, page: `plugins:${page}`, width, ...result });
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
    await window.webContents.executeJavaScript(`
      document.querySelector('.workspace').classList.add('workspace--rail-collapsed');
    `);
    await new Promise((resolve) => setTimeout(resolve, 80));
    results.push({
      height,
      page: 'rail:collapsed',
      width,
      ...(await window.webContents.executeJavaScript(inspectLayout)),
    });
    await window.webContents.executeJavaScript(`
      document.querySelector('.workspace').classList.remove('workspace--rail-collapsed');
      document.querySelector('#connection-advanced-dialog').showModal();
    `);
    await new Promise((resolve) => setTimeout(resolve, 80));
    results.push({
      height,
      page: 'connection:advanced-dialog',
      width,
      ...(await window.webContents.executeJavaScript(inspectLayout)),
    });
    await window.webContents.executeJavaScript(`
      document.querySelector('#connection-advanced-dialog').close();
    `);
  }

  const failures = results.filter(
    (result) =>
      result.documentOverflow ||
      result.hitTargetMisses.length > 0 ||
      result.overlaps.length > 0 ||
      result.overflow.length > 0 ||
      result.covered.length > 0,
  );
  console.log(JSON.stringify({ failures, sizes: results.length }, null, 2));
  app.exit(failures.length === 0 ? 0 : 1);
});
