const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const typescript = require('typescript');

const outputDirectory = path.join(__dirname, '..', 'dist', 'visual-qa');
app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-visual-smoke'));

const loadThemeDefinitions = () => {
  const source = readFileSync(
    path.join(__dirname, '..', 'src', 'shared', 'terminal-themes.ts'),
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
const themeOrder = ['claude', 'telegram', 'graphite', 'midnight'];

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

const applyQaTheme = (themeId) => `
  (() => {
    const definition = ${JSON.stringify(TERMINAL_THEMES[themeId])};
    const mapping = ${JSON.stringify(SHELL_CSS_VARIABLES)};
    for (const [field, property] of Object.entries(mapping)) {
      document.documentElement.style.setProperty(property, definition.shell[field]);
    }
    document.documentElement.dataset.theme = ${JSON.stringify(themeId)};
    document.documentElement.dataset.appearance = definition.appearance;
    document.documentElement.style.colorScheme = definition.appearance;
    document.querySelector('#terminal-theme').value = ${JSON.stringify(themeId)};
    document.querySelector('#settings-theme').value = ${JSON.stringify(themeId)};
    window.__claudeDockQaPalette = definition.palette;
  })()
`;

const installThemeMatrixFixtures = `
  (() => {
    const staticMotionStyle = document.createElement('style');
    staticMotionStyle.textContent =
      "html[data-qa-static-theme-matrix='true'] *, html[data-qa-static-theme-matrix='true'] *::before, html[data-qa-static-theme-matrix='true'] *::after { animation: none !important; transition: none !important; }";
    document.head.append(staticMotionStyle);

    const activatePage = (name) => {
      for (const page of document.querySelectorAll('[data-rail-page]')) {
        page.classList.toggle('rail-page--active', page.dataset.railPage === name);
      }
      for (const button of document.querySelectorAll('[data-rail-tab]')) {
        button.classList.toggle(
          'activity-rail__button--active',
          button.dataset.railTab === name,
        );
      }
    };

    window.__claudeDockShowRichChatFixture = () => {
      document.documentElement.dataset.qaStaticThemeMatrix = 'true';
      document.querySelector('#conversation-rename-dialog')?.close();
      document.querySelector('#connection-advanced-dialog')?.close();
      document.querySelector('#artifact-details-panel').dataset.open = 'false';
      document.querySelector('#artifact-details-panel').setAttribute('aria-hidden', 'true');
      document.querySelector('#artifact-details-scrim').hidden = true;
      document.querySelector('#claude-workbench').classList.remove('claude-workbench--open');
      document.querySelector('#terminal-shell').hidden = true;
      document.querySelector('#chat-shell').hidden = false;
      activatePage('chat');
      document.querySelector('#chat-active-model').textContent = 'claude-sonnet-4-5';
      document.querySelector('#chat-context-total').textContent = '18.4K tokens';
      document.querySelector('#chat-token-usage').textContent = '输入 12.8K · 输出 5.6K';

      const messages = document.querySelector('#chat-messages');
      messages.replaceChildren();
      const user = document.createElement('article');
      user.className = 'chat-message chat-message--user';
      const userLabel = document.createElement('strong');
      userLabel.textContent = '你';
      const userBody = document.createElement('div');
      userBody.className = 'chat-message__content';
      userBody.textContent = '请用富文本总结 2.0.0 的安全边界和最终效果。';
      user.append(userLabel, userBody);

      const assistant = document.createElement('article');
      assistant.className = 'chat-message chat-message--assistant';
      const assistantLabel = document.createElement('strong');
      assistantLabel.textContent = '模型';
      const body = document.createElement('div');
      body.className = 'chat-message__content chat-message__markdown';
      const heading = document.createElement('h1');
      heading.textContent = 'ClaudeDock 2.0.0 富文本';
      const intro = document.createElement('p');
      intro.append('输出通过 ', document.createElement('strong'), ' 构建；');
      intro.querySelector('strong').textContent = '安全 DOM';
      const link = document.createElement('a');
      link.href = 'https://example.com/security';
      link.textContent = '外链交给宿主打开';
      intro.append(link, '。');
      const remoteImage = document.createElement('span');
      remoteImage.className = 'markdown-remote-image';
      remoteImage.setAttribute('role', 'group');
      const remoteImageLabel = document.createElement('span');
      remoteImageLabel.className = 'markdown-remote-image__label';
      remoteImageLabel.textContent = '架构图（为保护隐私，未自动加载）';
      const remoteImageOpen = document.createElement('button');
      remoteImageOpen.className = 'button button--quiet markdown-remote-image__open';
      remoteImageOpen.type = 'button';
      remoteImageOpen.textContent = '在外部浏览器打开图片';
      remoteImage.append(remoteImageLabel, remoteImageOpen);
      const list = document.createElement('ul');
      for (const text of ['Markdown 与代码高亮', '公式和多模态附件', 'Artifact 默认不执行']) {
        const item = document.createElement('li');
        item.textContent = text;
        list.append(item);
      }
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const text of ['能力', '默认行为', '用户控制']) {
        const cell = document.createElement('th');
        cell.textContent = text;
        headRow.append(cell);
      }
      head.append(headRow);
      const tableBody = document.createElement('tbody');
      for (const values of [
        ['HTML', '显示为代码', '点击后隔离运行'],
        ['联网', '可审计', '详情面板一键断网'],
      ]) {
        const row = document.createElement('tr');
        for (const text of values) {
          const cell = document.createElement('td');
          cell.textContent = text;
          row.append(cell);
        }
        tableBody.append(row);
      }
      table.append(head, tableBody);
      const formula = document.createElement('span');
      formula.className = 'markdown-math markdown-math--display';
      formula.textContent = 'E = mc²   ·   ∫₀¹ x² dx = ⅓';
      const quote = document.createElement('blockquote');
      quote.textContent = '主文档 CSP 不放宽；可视化只在独立、不透明 origin 中运行。';
      const code = document.createElement('pre');
      code.className = 'markdown-code';
      code.dataset.language = 'typescript';
      const copy = document.createElement('button');
      copy.className = 'markdown-code__copy';
      copy.type = 'button';
      copy.textContent = '复制';
      const codeBody = document.createElement('code');
      const keyword = document.createElement('span');
      keyword.className = 'markdown-code__token';
      keyword.style.color = 'var(--accent-text)';
      keyword.textContent = 'const';
      codeBody.append(keyword, " secure = renderMarkdown(tokens);");
      code.append(copy, codeBody);
      body.append(heading, intro, remoteImage, list, table, formula, quote, code);
      assistant.append(assistantLabel, body);
      messages.append(user, assistant);
      messages.scrollTop = 0;
      document.querySelector('#chat-input').focus();
    };

    window.__claudeDockShowTerminalFixture = (masked) => {
      document.documentElement.dataset.qaStaticThemeMatrix = 'true';
      document.querySelector('#conversation-rename-dialog')?.close();
      document.querySelector('#connection-advanced-dialog')?.close();
      document.querySelector('#artifact-details-panel').dataset.open = 'false';
      document.querySelector('#artifact-details-panel').setAttribute('aria-hidden', 'true');
      document.querySelector('#artifact-details-scrim').hidden = true;
      document.querySelector('#claude-workbench').classList.remove('claude-workbench--open');
      document.querySelector('#terminal-shell').hidden = false;
      document.querySelector('#chat-shell').hidden = true;
      activatePage('projects');
      document.querySelector('#terminal-project').textContent = 'ClaudeDock · 静态视觉 fixture';
      const stage = document.querySelector('#terminal-stage');
      document.querySelector('#terminal-empty-state').style.display = 'none';
      stage.querySelector('.visual-terminal-fixture')?.remove();
      stage.querySelector('.terminal-mask')?.remove();
      const palette = window.__claudeDockQaPalette;
      const terminal = document.createElement('div');
      terminal.className =
        'project-terminal project-terminal--active visual-terminal-fixture';
      terminal.dataset.fixture = 'static-not-conpty';
      terminal.style.background = palette.background;
      terminal.style.color = palette.foreground;
      terminal.style.fontFamily = 'var(--font-mono)';
      terminal.style.fontSize = '14px';
      terminal.style.lineHeight = '1.55';
      terminal.style.overflow = 'hidden';
      terminal.style.padding = '20px';
      terminal.style.position = 'relative';
      const badge = document.createElement('span');
      badge.textContent = '静态视觉 fixture · 非 ConPTY';
      badge.style.background = 'var(--surface-3)';
      badge.style.border = '1px solid var(--line)';
      badge.style.borderRadius = 'var(--r-theme-pill)';
      badge.style.color = 'var(--text-lo)';
      badge.style.padding = '4px 10px';
      badge.style.position = 'absolute';
      badge.style.right = '12px';
      badge.style.top = '10px';
      const output = document.createElement('pre');
      output.className = 'visual-terminal-output';
      output.style.font = 'inherit';
      output.style.lineHeight = 'inherit';
      output.style.margin = '28px 0 0';
      output.style.whiteSpace = 'pre-wrap';
      const line = (parts) => {
        const row = document.createElement('div');
        for (const [text, color] of parts) {
          const span = document.createElement('span');
          span.textContent = text;
          span.style.color = color;
          row.append(span);
        }
        output.append(row);
      };
      line([['PowerShell 7.5.2', palette.brightCyan]]);
      line([['PS D:\\\\Projects\\\\ClaudeDock> ', palette.foreground], ['claude', palette.brightGreen]]);
      line([['✦ Claude Code 已准备就绪', palette.brightMagenta]]);
      line([['  模型 ', palette.brightBlack], ['claude-sonnet-4-5', palette.blue]]);
      line([['  参数 ', palette.brightBlack], ['--permission-mode default', palette.brightBlack]]);
      line([['  提示：亮色主题下 dim 与参数文字仍须清晰可辨。', palette.brightBlack]]);
      line([['> 正在分析终端尺寸、Markdown 与 Artifact 安全边界…', palette.cyan]]);
      line([['✓ 输出由应用接管；当前截图不代表真实 PTY resize 验收。', palette.green]]);
      terminal.append(badge, output);
      stage.prepend(terminal);

      if (masked) {
        const mask = document.createElement('div');
        mask.className = 'terminal-mask';
        mask.dataset.fixture = 'static-not-conpty';
        const snapshot = document.createElement('div');
        snapshot.className = 'terminal-mask__snapshot';
        const frozen = output.cloneNode(true);
        frozen.classList.add('terminal-mask__fallback');
        snapshot.append(frozen);
        const veil = document.createElement('div');
        veil.className = 'terminal-mask__veil';
        const label = document.createElement('span');
        label.className = 'terminal-mask__label';
        label.textContent = '正在执行操作';
        veil.append(label);
        mask.append(snapshot, veil);
        stage.append(mask);
      }
    };
  })()
`;

app
  .whenReady()
  .then(async () => {
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
    await window.webContents.executeJavaScript(installThemeMatrixFixtures);
    const captureSettledPage = async () => {
      window.webContents.invalidate();
      await window.capturePage();
      // Let the longest 280–300 ms Telegram-style entrance finish before visual comparison.
      await new Promise((resolve) => setTimeout(resolve, 420));
      return window.capturePage();
    };
    const themeMatrixCaptures = [];
    const captureThemeMatrixPage = async (filename, metadata) => {
      const image = await captureSettledPage();
      const png = image.toPNG();
      const size = image.getSize();
      if (png.length < 1_000 || size.width < 1 || size.height < 1) {
        throw new Error(`Invalid theme-matrix capture: ${filename}`);
      }
      writeFileSync(path.join(outputDirectory, filename), png);
      themeMatrixCaptures.push({
        file: filename,
        fixture: 'static-renderer',
        height: size.height,
        width: size.width,
        ...metadata,
      });
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
    document.body.dataset.agentRuntime = 'codex';
    document.querySelector('#runtime-claude').checked = false;
    document.querySelector('#runtime-codex').checked = true;
    document.querySelector('#workbench-tabs').hidden = true;
    document.querySelector('#workbench-title').textContent = 'Codex 工作台';
    document.querySelector('#workbench-trigger-label').textContent = 'Codex 工作台';
    const codexWorkbench = document.querySelector('#claude-workbench');
    codexWorkbench.classList.add('claude-workbench--open');
    codexWorkbench.setAttribute('aria-hidden', 'false');
    codexWorkbench.style.transform = 'translateX(0)';
    codexWorkbench.style.transition = 'none';
    document.querySelector('#workbench-scrim').hidden = false;
    for (const page of document.querySelectorAll('[data-workbench-page]')) {
      page.classList.toggle('workbench-page--active', page.dataset.workbenchPage === 'codex');
    }
    document.querySelector('#codex-install-step').dataset.state = 'ready';
    document.querySelector('#codex-install-title').textContent = 'Codex CLI 0.146.0 已就绪';
    document.querySelector('#codex-install-detail').textContent =
      'Codex CLI 0.146.0 已就绪，已使用官方独立安装版。';
    document.querySelector('#codex-install').hidden = true;
    document.querySelector('#codex-account-step').dataset.state = 'ready';
    document.querySelector('#codex-account-title').textContent = 'ChatGPT 已登录';
    document.querySelector('#codex-account-detail').textContent =
      'Plus 订阅 · 登录由 Codex 官方维护，ClaudeDock 不读取令牌';
    document.querySelector('#codex-login').hidden = true;
    document.querySelector('#codex-project-step').dataset.state = 'ready';
    document.querySelector('#codex-project-title').textContent = '当前项目可安全开发';
    document.querySelector('#codex-project-detail').textContent =
      '默认只写当前工作区；扩大权限前仍会确认';
    document.querySelector('#codex-usage-card').hidden = false;
    document.querySelector('#codex-plan').textContent = 'Plus · ChatGPT 订阅';
    document.querySelector('#codex-quota-label').textContent = '短周期额度';
    document.querySelector('#codex-quota-value').textContent = '已使用 34%';
    document.querySelector('#codex-quota-bar').style.width = '34%';
    document.querySelector('#codex-primary-action').textContent = '启动 Codex';
  `);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await window.webContents.executeJavaScript(`
      document.querySelector('#codex-workbench-page').scrollTop = 0;
    `);
    writeFileSync(
      path.join(outputDirectory, 'codex-workbench-1180.png'),
      (await captureSettledPage()).toPNG(),
    );
    await window.webContents.executeJavaScript(`
    document.querySelector('#claude-workbench').classList.remove('claude-workbench--open');
    document.querySelector('#claude-workbench').setAttribute('aria-hidden', 'true');
    document.querySelector('#claude-workbench').style.removeProperty('transform');
    document.querySelector('#claude-workbench').style.removeProperty('transition');
    document.querySelector('#workbench-scrim').hidden = true;
    document.body.dataset.agentRuntime = 'claude';
    document.querySelector('#runtime-claude').checked = true;
    document.querySelector('#runtime-codex').checked = false;
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
    const artifactDetailsPanel = document.querySelector('#artifact-details-panel');
    artifactDetailsPanel.dataset.open = 'true';
    artifactDetailsPanel.setAttribute('aria-hidden', 'false');
    artifactDetailsPanel.inert = false;
    artifactDetailsPanel.removeAttribute('inert');
    artifactDetailsPanel.style.transform = 'translateX(0)';
    artifactDetailsPanel.style.transition = 'none';
    document.querySelector('#artifact-details-scrim').hidden = false;
    document.querySelector('#chat-artifact-details').setAttribute('aria-expanded', 'true');
    for (const [selector, copy] of [
      ['#artifact-active-list', '当前没有正在运行的可视化。'],
      ['#artifact-network-log', '还没有网络请求。内置库不会计入外部联网审计。'],
    ]) {
      const container = document.querySelector(selector);
      if (!container.children.length) {
        const empty = document.createElement(selector === '#artifact-network-log' ? 'li' : 'p');
        empty.className = 'artifact-details__empty';
        empty.textContent = copy;
        container.append(empty);
      }
    }
  `);
    writeFileSync(
      path.join(outputDirectory, 'chat-artifact-details-claude-light-1180.png'),
      (await captureSettledPage()).toPNG(),
    );
    await window.webContents.executeJavaScript(`
    document.querySelector('#artifact-details-panel').dataset.open = 'false';
    document.querySelector('#artifact-details-panel').setAttribute('aria-hidden', 'true');
    document.querySelector('#artifact-details-panel').inert = true;
    document.querySelector('#artifact-details-panel').setAttribute('inert', '');
    document.querySelector('#artifact-details-panel').style.removeProperty('transform');
    document.querySelector('#artifact-details-panel').style.removeProperty('transition');
    document.querySelector('#artifact-details-scrim').hidden = true;
    document.querySelector('#chat-artifact-details').setAttribute('aria-expanded', 'false');
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

    window.setSize(1180, 760);
    for (const theme of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(theme));

      await window.webContents.executeJavaScript(`window.__claudeDockShowRichChatFixture()`);
      await captureThemeMatrixPage(`${theme}-chat-rich-1180.png`, {
        scene: 'chat-rich',
        theme,
      });

      await window.webContents.executeJavaScript(`window.__claudeDockShowTerminalFixture(false)`);
      await captureThemeMatrixPage(`${theme}-terminal-static-1180.png`, {
        scene: 'terminal',
        theme,
      });

      await window.webContents.executeJavaScript(`window.__claudeDockShowTerminalFixture(true)`);
      await captureThemeMatrixPage(`${theme}-terminal-mask-static-1180.png`, {
        scene: 'terminal-mask',
        theme,
      });
    }

    const expectedThemeMatrixCaptures = themeOrder.length * 3;
    if (themeMatrixCaptures.length !== expectedThemeMatrixCaptures) {
      throw new Error(
        `Theme matrix is incomplete: expected ${expectedThemeMatrixCaptures}, captured ${themeMatrixCaptures.length}`,
      );
    }
    writeFileSync(
      path.join(outputDirectory, 'theme-matrix-manifest.json'),
      `${JSON.stringify(
        {
          captures: themeMatrixCaptures,
          disclaimer:
            'Terminal and mask images are static renderer fixtures. They verify theme and layout only; they are not ConPTY, PTY resize, or PSReadLine integration evidence.',
          expectedCaptures: expectedThemeMatrixCaptures,
          generatedAt: new Date().toISOString(),
          themes: themeOrder,
        },
        null,
        2,
      )}\n`,
    );

    console.log(outputDirectory);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
