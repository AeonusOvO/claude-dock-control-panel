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

const activatePluginPage = (name) => `
  for (const tab of document.querySelectorAll('[data-plugin-tab]')) {
    tab.classList.toggle('plugin-tab--active', tab.dataset.pluginTab === ${JSON.stringify(name)});
  }
  for (const panel of document.querySelectorAll('[data-plugin-panel]')) {
    panel.classList.toggle('plugin-panel--active', panel.dataset.pluginPanel === ${JSON.stringify(name)});
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

  await window.webContents.executeJavaScript(`
    ${activateRailPage('plugins')}
    ${activatePluginPage('marketplaces')}
    (() => {
      const list = document.querySelector('#plugin-marketplace-list');
      list.replaceChildren();
      const card = document.createElement('article');
      card.className = 'plugin-card plugin-card--marketplace';
      const header = document.createElement('div');
      header.className = 'plugin-card__header';
      const title = document.createElement('strong');
      title.textContent = 'claude-plugins-official-with-a-long-responsive-name';
      header.append(title);
      const source = document.createElement('code');
      source.textContent =
        'https://github.com/anthropics/claude-plugins-official/tree/main/plugins';
      const actions = document.createElement('div');
      actions.className = 'plugin-card__actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除市场';
      actions.append(remove);
      card.append(header, source, actions);
      list.append(card);
    })();
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'plugins-820.png'),
    (await window.capturePage()).toPNG(),
  );

  window.setSize(1180, 760);
  await window.webContents.executeJavaScript(`
    ${activateRailPage('connection')}
    document.querySelector('#environment-setup').hidden = true;
    document.querySelector('#connection-provider-picker').setAttribute('aria-disabled', 'false');
    document.querySelector('#connection-provider-setup').hidden = false;
    document.querySelector('#connection-provider-title').textContent = 'DeepSeek';
    document.querySelector('#connection-provider-description').textContent =
      'DeepSeek 官方 Anthropic 兼容接口，适合国内网络环境。';
    document.querySelector('#connection-provider-caveat').hidden = true;
    document.querySelector('#claude-config-form').hidden = false;
    const groups = document.querySelector('#connection-provider-groups');
    groups.replaceChildren();
    for (const fixture of [
      ['官方接入', ['Anthropic 官方登录', 'Anthropic API Key']],
      ['国内服务', ['DeepSeek', '智谱 GLM（国内）', 'Kimi 开放平台', '通义千问（国内）']],
      ['海外与聚合服务', ['智谱 GLM（国际）', 'OpenRouter']],
    ]) {
      const section = document.createElement('section');
      section.className = 'provider-group';
      const heading = document.createElement('strong');
      heading.className = 'provider-group__title';
      heading.textContent = fixture[0];
      const grid = document.createElement('div');
      grid.className = 'provider-card-grid';
      for (const label of fixture[1]) {
        const card = document.createElement('button');
        card.className = 'provider-card';
        card.classList.toggle('provider-card--selected', label === 'DeepSeek');
        card.type = 'button';
        const title = document.createElement('strong');
        title.textContent = label;
        const detail = document.createElement('span');
        detail.textContent = '由服务商目录自动填入兼容端点、认证方式与推荐模型。';
        card.append(title, detail);
        grid.append(card);
      }
      section.append(heading, grid);
      groups.append(section);
    }
    document.querySelector('.control-panel').scrollTop = 0;
    document.querySelector('[data-rail-page="connection"]').style.animation = 'none';
    for (const button of document.querySelectorAll('[data-rail-tab]')) {
      button.classList.toggle(
        'activity-rail__button--active',
        button.dataset.railTab === 'connection',
      );
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'connection-1180.png'),
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
