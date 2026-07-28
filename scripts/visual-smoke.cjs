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
    // Let the longest 280–300 ms Telegram-style entrance finish before visual comparison.
    await new Promise((resolve) => setTimeout(resolve, 360));
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
      ['官方接入', ['Anthropic 官方登录', 'Anthropic API Key'], true],
      ['国内服务', ['DeepSeek', '智谱 GLM（国内）', 'Kimi 开放平台', '通义千问（国内）'], false],
      ['海外与聚合服务', ['智谱 GLM（国际）', 'OpenRouter', '硅基流动'], true],
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
    historyMeta.textContent =
      '07/27 23:58 · Bearer · 含凭据 · ClaudeDock 单一凭据 · 网关运行中';
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
    path.join(outputDirectory, 'global-settings-1180.png'),
    (await captureSettledPage()).toPNG(),
  );
  await window.webContents.executeJavaScript(`
    for (const tab of document.querySelectorAll('[data-settings-tab]')) {
      const selected = tab.dataset.settingsTab === 'connection';
      tab.classList.toggle('settings-tab--active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    for (const panel of document.querySelectorAll('[data-settings-panel]')) {
      panel.classList.toggle(
        'settings-panel--active',
        panel.dataset.settingsPanel === 'connection',
      );
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'global-settings-connection-1180.png'),
    (await captureSettledPage()).toPNG(),
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('#connection-advanced-dialog').close();
    document.documentElement.style.setProperty('--rail-w', '360px');
    ${activateRailPage('projects')}
    const focusEmptyTerminal = document.querySelector('#terminal-empty-state');
    focusEmptyTerminal.classList.add('terminal-empty-state--hidden');
    focusEmptyTerminal.style.display = 'none';
    const focusFixture = document.createElement('div');
    focusFixture.className = 'project-terminal project-terminal--active';
    focusFixture.id = 'terminal-focus-fixture';
    focusFixture.tabIndex = 0;
    const terminalText = document.createElement('pre');
    terminalText.textContent =
      'PowerShell 7.5.2\\nPS D:\\\\Projects\\\\ClaudeDock> claude\\nClaude Code 已准备就绪';
    terminalText.style.color = 'var(--text-hi)';
    terminalText.style.padding = '14px';
    focusFixture.append(terminalText);
    document.querySelector('#terminal-stage').prepend(focusFixture);
    focusFixture.focus();
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'terminal-focus-1180.png'),
    (await captureSettledPage()).toPNG(),
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('#terminal-shell').hidden = true;
    document.querySelector('#chat-shell').hidden = false;
    ${activateRailPage('chat')}
    for (const button of document.querySelectorAll('[data-rail-tab]')) {
      button.classList.toggle(
        'activity-rail__button--active',
        button.dataset.railTab === 'chat',
      );
    }
    document.querySelector('#chat-active-model').textContent = 'claude-sonnet-4-5';
    document.querySelector('#chat-context-total').textContent = '1.2K tokens';
    document.querySelector('#chat-token-usage').textContent = '输入 986 · 输出 238';
    document.querySelector('#chat-connection-test').dataset.tone = 'success';
    document.querySelector('#chat-connection-test').textContent =
      '连接成功，接口、认证与模型响应均可用。 · 412 ms · 6 tokens';
    const chatHistory = document.querySelector('#chat-history-list');
    chatHistory.replaceChildren();
    for (const [titleText, metaText, active] of [
      ['总结 ClaudeDock 当前状态', '7月28日 21:42 · 4 条消息 · 1.2K tokens', true],
      ['比较两套亮色主题', '7月28日 20:16 · 6 条消息 · 2.8K tokens', false],
    ]) {
      const item = document.createElement('div');
      item.className = 'chat-history__item';
      item.dataset.active = String(active);
      const open = document.createElement('button');
      open.className = 'chat-history__open';
      open.type = 'button';
      const title = document.createElement('strong');
      title.textContent = titleText;
      const meta = document.createElement('span');
      meta.textContent = metaText;
      open.append(title, meta);
      const remove = document.createElement('button');
      remove.className = 'chat-history__delete';
      remove.type = 'button';
      remove.textContent = '×';
      item.append(open, remove);
      chatHistory.append(item);
    }
    document.querySelector('#chat-history-empty').hidden = true;
    document.querySelector('#chat-history-count').textContent = '2 条';
    document.querySelector('#chat-empty-state').hidden = true;
    const messages = document.querySelector('#chat-messages');
    for (const [role, label, content] of [
      ['user', '你', '请用三点总结这个项目的当前状态。'],
      [
        'assistant',
        '模型',
        '1. 项目终端保持独立运行。\\n2. 对话页使用单独配置的模型。\\n3. 全局设置统一管理应用偏好与接入工具。',
      ],
    ]) {
      const article = document.createElement('article');
      article.className = \`chat-message chat-message--\${role}\`;
      const heading = document.createElement('strong');
      heading.textContent = label;
      const body = document.createElement('div');
      body.className = 'chat-message__content';
      body.textContent = content;
      article.append(heading, body);
      messages.append(article);
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeFileSync(
    path.join(outputDirectory, 'chat-claude-light-1180.png'),
    (await captureSettledPage()).toPNG(),
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('#chat-connection-test').scrollIntoView({ block: 'center' });
  `);
  writeFileSync(
    path.join(outputDirectory, 'chat-connection-test-claude-light-1180.png'),
    (await captureSettledPage()).toPNG(),
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('#terminal-focus-fixture').remove();
    document.querySelector('#terminal-shell').hidden = false;
    document.querySelector('#chat-shell').hidden = true;
    document.querySelector('#terminal-empty-state').style.display = '';
    document.querySelector('#terminal-empty-state').classList.remove('terminal-empty-state--hidden');
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
