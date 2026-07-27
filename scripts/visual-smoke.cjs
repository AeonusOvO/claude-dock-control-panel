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
  const captureSettledPage = async () => {
    window.webContents.invalidate();
    await window.capturePage();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return window.capturePage();
  };

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
    (await captureSettledPage()).toPNG(),
  );

  window.setSize(1180, 760);
  await window.webContents.executeJavaScript(`
    ${activateRailPage('connection')}
    document.documentElement.style.setProperty('--rail-w', '560px');
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
      ['官方接入', ['Anthropic 官方登录', 'Anthropic API Key'], false],
      ['国内服务', ['DeepSeek', '智谱 GLM（国内）', 'Kimi 开放平台', '通义千问（国内）'], false],
      ['海外与聚合服务', ['智谱 GLM（国际）', 'OpenRouter', '硅基流动'], false],
      ['高级方式', ['从 cURL 识别', '本机转换器 / 模型网关', '自定义接口'], true],
    ]) {
      const section = document.createElement('section');
      section.className = 'provider-group';
      section.dataset.collapsed = String(fixture[2]);
      const toggle = document.createElement('button');
      toggle.className = 'provider-group__toggle';
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(!fixture[2]));
      const heading = document.createElement('span');
      heading.className = 'provider-group__title';
      heading.textContent = fixture[0];
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrow.setAttribute('class', 'provider-group__arrow');
      arrow.setAttribute('viewBox', '0 0 24 24');
      const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arrowPath.setAttribute('d', 'm9 5 7 7-7 7');
      arrow.append(arrowPath);
      toggle.append(heading, arrow);
      const content = document.createElement('div');
      content.className = 'provider-group__content';
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
      content.append(grid);
      section.append(toggle, content);
      groups.append(section);
    }
    const historyList = document.querySelector('#connection-history-list');
    historyList.replaceChildren();
    const historyItem = document.createElement('li');
    historyItem.className = 'connection-history__item';
    const historyRestore = document.createElement('button');
    historyRestore.className = 'connection-history__restore';
    historyRestore.type = 'button';
    const historyTitle = document.createElement('strong');
    historyTitle.textContent = '本机转换器 / 模型网关';
    const historyParameters = document.createElement('span');
    historyParameters.className = 'connection-history__parameters';
    for (const [labelText, valueText] of [
      ['接口 / 网关', 'http://127.0.0.1:3456'],
      ['主模型', 'deepseek/deepseek-v4-pro'],
      ['快速模型', 'deepseek/deepseek-v4-flash'],
    ]) {
      const parameter = document.createElement('span');
      parameter.className = 'connection-history__parameter';
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('code');
      value.textContent = valueText;
      parameter.append(label, value);
      historyParameters.append(parameter);
    }
    const historyMeta = document.createElement('span');
    historyMeta.className = 'connection-history__meta';
    historyMeta.textContent = '07/27 23:58 · Bearer · 含凭据 · 网关运行中';
    historyRestore.append(historyTitle, historyParameters, historyMeta);
    const historyDelete = document.createElement('button');
    historyDelete.className = 'connection-history__delete';
    historyDelete.type = 'button';
    historyDelete.textContent = '×';
    historyItem.append(historyRestore, historyDelete);
    historyList.append(historyItem);
    document.querySelector('#connection-history-empty').hidden = true;
    document.querySelector('#connection-history-count').textContent =
      '1 条历史配置 · 点击恢复全部参数';
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
    (await captureSettledPage()).toPNG(),
  );

  await window.webContents.executeJavaScript(`
    document.querySelector('#connection-history').scrollIntoView({ block: 'start' });
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'connection-history-1180.png'),
    (await captureSettledPage()).toPNG(),
  );

  await window.webContents.executeJavaScript(`
    document.querySelector('#connection-advanced-dialog').showModal();
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'advanced-settings-1180.png'),
    (await captureSettledPage()).toPNG(),
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('#connection-advanced-dialog').close();
  `);

  window.setSize(1000, 720);
  await window.webContents.executeJavaScript(`
    ${activateRailPage('projects')}
    document.querySelector('#conversation-rename-input').value = '终端主题与中文输入修复';
    document.querySelector('#conversation-rename-dialog').showModal();
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'rename-theme-1000.png'),
    (await captureSettledPage()).toPNG(),
  );

  console.log(outputDirectory);
  app.exit(0);
});
