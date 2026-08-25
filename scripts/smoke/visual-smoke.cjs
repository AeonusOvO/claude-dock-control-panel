/* eslint-disable max-lines, max-lines-per-function -- 单进程线性视觉场景脚本：主体为内联 DOM fixture 模板字符串，场景靠累积 DOM 状态隐式串联，拆分会破坏截图时序。 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const typescript = require('typescript');

const outputDirectory = path.join(__dirname, '..', '..', 'dist', 'visual-qa');
app.setPath('userData', path.join(__dirname, '..', '..', 'dist', '.electron-visual-smoke'));

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
    await window.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
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

    window.setSize(1180, 760);
    await window.webContents.executeJavaScript(`
      (() => {
        const shell = document.querySelector('#onboarding-shell');
        shell.hidden = false;
        shell.dataset.state = 'open';
        shell.querySelector('.onboarding-surface').style.animation = 'none';
        shell.querySelector('.onboarding-shell__backdrop').style.animation = 'none';
        delete document.querySelector('#onboarding-viewport').dataset.direction;
        for (const step of shell.querySelectorAll('[data-onboarding-step]')) {
          const active = step.dataset.onboardingStep === 'engine';
          step.hidden = !active;
          step.classList.toggle('onboarding-step--active', active);
          step.classList.remove('onboarding-step--leaving');
          step.style.animation = 'none';
        }
        for (const button of shell.querySelectorAll('[data-onboarding-progress-step]')) {
          button.dataset.state = button.dataset.onboardingProgressStep === 'engine' ? 'active' : 'pending';
        }
        shell.querySelector('[data-onboarding-engine="claude"]').setAttribute('aria-checked', 'true');
        shell.querySelector('[data-onboarding-engine="codex"]').setAttribute('aria-checked', 'false');
        document.querySelector('#onboarding-engine-hint').textContent = '已选择 Claude Code';
        document.querySelector('#onboarding-engine-next').disabled = false;
      })();
    `);
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await window.webContents.executeJavaScript(`
        (() => {
          for (const step of document.querySelectorAll('#onboarding-shell [data-onboarding-step]')) {
            const active = step.dataset.onboardingStep === 'engine';
            step.hidden = !active;
            step.classList.toggle('onboarding-step--active', active);
            step.classList.remove('onboarding-step--leaving');
          }
          for (const button of document.querySelectorAll('[data-onboarding-progress-step]')) {
            button.dataset.state = button.dataset.onboardingProgressStep === 'engine' ? 'active' : 'pending';
          }
        })();
      `);
      writeFileSync(
        path.join(outputDirectory, `onboarding-engine-${themeId}-1180.png`),
        (await captureSettledPage()).toPNG(),
      );
      await window.webContents.executeJavaScript(`
        (() => {
          for (const step of document.querySelectorAll('#onboarding-shell [data-onboarding-step]')) {
            const active = step.dataset.onboardingStep === 'model';
            step.hidden = !active;
            step.classList.toggle('onboarding-step--active', active);
            step.classList.remove('onboarding-step--leaving');
          }
          for (const button of document.querySelectorAll('[data-onboarding-progress-step]')) {
            button.dataset.state = button.dataset.onboardingProgressStep === 'engine'
              ? 'completed'
              : button.dataset.onboardingProgressStep === 'model'
                ? 'active'
                : 'pending';
          }
          document.querySelector('[data-onboarding-model-choice="domestic"]').setAttribute('aria-checked', 'true');
          document.querySelector('#onboarding-domestic-model-picker').hidden = false;
          document.querySelector('#onboarding-domestic-model').value = 'deepseek';
          const triggerLabel = document.querySelector('#onboarding-domestic-model')
            ?.closest('.select')
            ?.querySelector('.select__label');
          if (triggerLabel) triggerLabel.textContent = 'DeepSeek';
          document.querySelector('#onboarding-model-hint').textContent = '当前已选择 DeepSeek';
          document.querySelector('#onboarding-model-next').disabled = false;
        })();
      `);
      writeFileSync(
        path.join(outputDirectory, `onboarding-model-${themeId}-1180.png`),
        (await captureSettledPage()).toPNG(),
      );
    }
    window.setSize(820, 720);
    await window.webContents.executeJavaScript(applyQaTheme('claude'));
    await window.webContents.executeJavaScript(`
      (() => {
        for (const step of document.querySelectorAll('#onboarding-shell [data-onboarding-step]')) {
          const active = step.dataset.onboardingStep === 'engine';
          step.hidden = !active;
          step.classList.toggle('onboarding-step--active', active);
          step.classList.remove('onboarding-step--leaving');
        }
        for (const button of document.querySelectorAll('[data-onboarding-progress-step]')) {
          button.dataset.state = button.dataset.onboardingProgressStep === 'engine' ? 'active' : 'pending';
        }
      })();
    `);
    writeFileSync(
      path.join(outputDirectory, 'onboarding-engine-claude-820.png'),
      (await captureSettledPage()).toPNG(),
    );
    await window.webContents.executeJavaScript(`
      (() => {
        for (const step of document.querySelectorAll('#onboarding-shell [data-onboarding-step]')) {
          const active = step.dataset.onboardingStep === 'model';
          step.hidden = !active;
          step.classList.toggle('onboarding-step--active', active);
        }
        for (const button of document.querySelectorAll('[data-onboarding-progress-step]')) {
          button.dataset.state = button.dataset.onboardingProgressStep === 'engine'
            ? 'completed'
            : button.dataset.onboardingProgressStep === 'model'
              ? 'active'
              : 'pending';
        }
      })();
    `);
    writeFileSync(
      path.join(outputDirectory, 'onboarding-model-claude-820.png'),
      (await captureSettledPage()).toPNG(),
    );
    const probeOnboardingTransition = async (from, to, direction) => {
      const baseline = await window.webContents.executeJavaScript(`
        (() => {
          const viewport = document.querySelector('#onboarding-viewport');
          for (const step of document.querySelectorAll('#onboarding-shell [data-onboarding-step]')) {
            const active = step.dataset.onboardingStep === ${JSON.stringify(to)};
            step.hidden = !active;
            step.classList.toggle('onboarding-step--active', active);
            step.classList.remove('onboarding-step--leaving');
            step.style.animation = 'none';
          }
          delete viewport.dataset.direction;
          return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        })()
      `);
      await window.webContents.executeJavaScript(`
        (() => {
          const viewport = document.querySelector('#onboarding-viewport');
          const fromStep = document.querySelector('[data-onboarding-step=${JSON.stringify(from)}]');
          const toStep = document.querySelector('[data-onboarding-step=${JSON.stringify(to)}]');
          for (const step of document.querySelectorAll('#onboarding-shell [data-onboarding-step]')) {
            step.hidden = true;
            step.classList.remove('onboarding-step--active', 'onboarding-step--leaving');
            step.style.removeProperty('animation');
          }
          viewport.dataset.direction = ${JSON.stringify(direction)};
          fromStep.hidden = false;
          fromStep.classList.add('onboarding-step--leaving');
          toStep.hidden = false;
          toStep.classList.add('onboarding-step--active');
          void viewport.offsetHeight;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const frame = await window.capturePage();
      writeFileSync(
        path.join(outputDirectory, `onboarding-transition-${direction}-claude-820.png`),
        frame.toPNG(),
      );
      const transient = await window.webContents.executeJavaScript(`
        (() => {
          const viewport = document.querySelector('#onboarding-viewport');
          return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        })()
      `);
      if (transient > baseline + 2) {
        throw new Error(
          `Onboarding ${direction} transition created transient scrollbar overflow: ${transient}px (baseline ${baseline}px)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 340));
    };
    await probeOnboardingTransition('engine', 'model', 'forward');
    await probeOnboardingTransition('model', 'engine', 'backward');
    await window.webContents.executeJavaScript(`
      document.querySelector('#onboarding-shell').hidden = true;
    `);

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

    const mcpFixtureScript = `
    ${activateRailPage('mcp')}
    (() => {
      try {
      document.querySelector('#mcp-status').textContent =
        '发现 3 个 MCP · 官方注册表已连接 · 上次读取 14:30';
      document.querySelector('#mcp-installed-count').textContent = '3';
      const installed = document.querySelector('#mcp-installed-list');
      installed.replaceChildren();
      for (const fixture of [
        ['filesystem', 'Claude · stdio', '已连接 · MCP initialize 握手成功。', 'project · 项目共享', 'D:/Program/ClaudeDesk/.mcp.json'],
        ['context7', 'Claude · http', '连接失败 · 初始化请求返回 HTTP 401。', 'user · 用户级', 'C:/Users/ExampleUser/.claude.json'],
        ['node_repl', 'Codex · stdio', '状态未知 · 来自 Codex CLI；ClaudeDock 仅只读发现。', 'user · 用户级', 'C:/Users/ExampleUser/.codex/config.toml'],
      ]) {
        const card = document.createElement('article');
        card.className = 'plugin-card';
        card.dataset.installed = 'true';
        const header = document.createElement('div');
        header.className = 'plugin-card__header';
        const title = document.createElement('strong');
        title.textContent = fixture[0];
        const badge = document.createElement('span');
        badge.className = 'plugin-card__badge';
        badge.textContent = fixture[1];
        header.append(title, badge);
        const health = document.createElement('p');
        health.className = 'mcp-card__health';
        health.dataset.health = fixture[2].startsWith('已连接') ? 'connected' : fixture[2].startsWith('连接失败') ? 'failed' : 'unknown';
        health.textContent = fixture[2];
        const meta = document.createElement('div');
        meta.className = 'plugin-card__meta';
        meta.textContent = fixture[3];
        const source = document.createElement('code');
        source.className = 'mcp-card__path';
        source.textContent = fixture[4];
        card.append(header, health, meta, source);
        installed.append(card);
      }
      const catalog = document.querySelector('#mcp-catalog-list');
      catalog.replaceChildren();
      const card = document.createElement('article');
      card.className = 'plugin-card';
      const header = document.createElement('div');
      header.className = 'plugin-card__header';
      const title = document.createElement('strong');
      title.textContent = 'sequential-thinking';
      const badge = document.createElement('span');
      badge.className = 'plugin-card__badge';
      badge.textContent = '精选 · stdio';
      header.append(title, badge);
      const description = document.createElement('p');
      description.textContent = '提供结构化、可修订的顺序思考工具。';
      const install = document.createElement('button');
      install.textContent = '安装';
      card.append(header, description, install);
      catalog.append(card);
      return 'ok';
      } catch (error) {
        return error instanceof Error ? error.stack : String(error);
      }
    })();
  `;
    new vm.Script(mcpFixtureScript);
    const mcpFixtureResult = await window.webContents.executeJavaScript(mcpFixtureScript);
    if (mcpFixtureResult !== 'ok') {
      throw new Error(`MCP visual fixture failed: ${mcpFixtureResult}`);
    }
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      writeFileSync(
        path.join(outputDirectory, `mcp-${themeId}-820.png`),
        (await captureSettledPage()).toPNG(),
      );
    }
    await window.webContents.executeJavaScript(applyQaTheme('claude'));

    window.setSize(1180, 760);
    await window.webContents.executeJavaScript(`
    ${activateRailPage('connection')}
    document.documentElement.style.setProperty('--rail-w', '560px');
    document.querySelector('#environment-setup').hidden = true;
    document.querySelector('#connection-provider-picker').setAttribute('aria-disabled', 'false');
    const wizardChoice = document.querySelector('[data-connection-wizard-step="choice"]');
    const wizardConfigure = document.querySelector('[data-connection-wizard-step="configure"]');
    wizardChoice.hidden = false;
    wizardChoice.classList.add('connection-wizard-step--active');
    wizardConfigure.hidden = true;
    wizardConfigure.classList.remove('connection-wizard-step--active');
    document.querySelector('#connection-wizard-progress-choice').dataset.state = 'active';
    document.querySelector('#connection-wizard-progress-configure').dataset.state = 'pending';
    document.querySelector('#connection-wizard-previous').disabled = true;
    document.querySelector('#connection-wizard-next').disabled = false;
    document.querySelector('#connection-wizard-status').textContent = '已选择 ChatGPT 官方订阅';
    document.querySelector('#connection-provider-setup').hidden = false;
    document.querySelector('#connection-provider-title').textContent =
      'ChatGPT 订阅（ClaudeDock 托管）';
    document.querySelector('#connection-provider-description').textContent =
      '由 ClaudeDock 一键安装、授权并托管本机网关，把 ChatGPT Codex 订阅接入当前 Claude Code 项目。';
    document.querySelector('#connection-provider-caveat').hidden = false;
    document.querySelector('#connection-provider-caveat').textContent =
      '这条路径由 OpenAI Codex 负责人 Tibo 公开分享；CLIProxyAPI 仍是第三方开源网关，不是 OpenAI 或 Anthropic 官方产品。';
    document.querySelector('#claude-config-form').hidden = true;
    const advancedConnection = document.querySelector('#connection-advanced-content');
    for (const selector of [
      '#credential-source-settings',
      '#connection-advice',
      '#gateway-discovery',
      '#curl-onboarding',
      '#converter-help',
      '.connection-glossary',
    ]) {
      const advancedNode = document.querySelector(selector);
      if (advancedNode) advancedConnection.append(advancedNode);
    }
    document.querySelector('#router-settings-content').append(document.querySelector('#router-manager'));
    const specialSetup = document.querySelector('#connection-provider-special');
    const subscriptionGuide = document.createElement('section');
    subscriptionGuide.className = 'subscription-gateway-guide';
    const subscriptionTitle = document.createElement('strong');
    subscriptionTitle.textContent = 'OpenAI Codex 负责人公开分享的 claudex 路径';
    const subscriptionSource = document.createElement('p');
    subscriptionSource.textContent =
      'Thibault “Tibo” Sottiaux 公开分享了 CLIProxyAPI 接入 Claude Code 的实践。ClaudeDock 把安装、配置和后台运行收进一个界面。';
    const subscriptionStatus = document.createElement('div');
    subscriptionStatus.className = 'subscription-gateway-status';
    subscriptionStatus.dataset.phase = 'ready';
    const subscriptionStatusText = document.createElement('div');
    const subscriptionStatusTitle = document.createElement('strong');
    subscriptionStatusTitle.textContent = 'ChatGPT 一键接入已就绪';
    const subscriptionStatusDetail = document.createElement('span');
    subscriptionStatusDetail.textContent = '实时模型目录和真实连接测试均已通过。';
    subscriptionStatusText.append(subscriptionStatusTitle, subscriptionStatusDetail);
    const subscriptionAction = document.createElement('button');
    subscriptionAction.type = 'button';
    subscriptionAction.textContent = '检查并自动修复';
    subscriptionStatus.append(subscriptionStatusText, subscriptionAction);
    const subscriptionProgress = document.createElement('div');
    subscriptionProgress.className = 'subscription-gateway-progress';
    const subscriptionProgressTitle = document.createElement('strong');
    subscriptionProgressTitle.textContent = '第 8/8 步';
    const subscriptionProgressDetail = document.createElement('span');
    subscriptionProgressDetail.textContent = '连接已通过，当前项目配置保存完成。';
    const subscriptionProgressMeter = document.createElement('progress');
    subscriptionProgressMeter.max = 8;
    subscriptionProgressMeter.value = 8;
    subscriptionProgress.append(
      subscriptionProgressTitle,
      subscriptionProgressDetail,
      subscriptionProgressMeter,
    );
    const subscriptionModel = document.createElement('label');
    subscriptionModel.className = 'field subscription-gateway-model';
    const subscriptionModelLabel = document.createElement('span');
    subscriptionModelLabel.textContent = '当前模型';
    const subscriptionModelSelect = document.createElement('select');
    subscriptionModelSelect.className = 'select-native';
    subscriptionModelSelect.dataset.enhanced = 'true';
    for (const model of ['gpt-5.6-sol', 'gpt-5.4-mini']) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      subscriptionModelSelect.append(option);
    }
    const subscriptionModelHelp = document.createElement('small');
    subscriptionModelHelp.textContent =
      '列表来自本机网关实时接口；切换后会自动复测并保存，无需再点接入。';
    const subscriptionModelShell = document.createElement('div');
    subscriptionModelShell.className = 'select';
    const subscriptionModelTrigger = document.createElement('button');
    subscriptionModelTrigger.className = 'select__trigger';
    subscriptionModelTrigger.type = 'button';
    const subscriptionModelTriggerLabel = document.createElement('span');
    subscriptionModelTriggerLabel.className = 'select__label';
    subscriptionModelTriggerLabel.textContent = 'gpt-5.6-sol';
    const subscriptionModelChevron = document.createElement('span');
    subscriptionModelChevron.className = 'select__chevron';
    subscriptionModelChevron.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>';
    subscriptionModelTrigger.append(subscriptionModelTriggerLabel, subscriptionModelChevron);
    subscriptionModelShell.append(subscriptionModelSelect, subscriptionModelTrigger);
    subscriptionModel.append(subscriptionModelLabel, subscriptionModelShell, subscriptionModelHelp);
    const subscriptionBoundary = document.createElement('small');
    subscriptionBoundary.textContent =
      '一次点击会自动检测环境、补齐组件、授权、读取模型、真实测试并保存；此方式不需要 CCR。';
    subscriptionGuide.append(
      subscriptionTitle,
      subscriptionSource,
      subscriptionStatus,
      subscriptionProgress,
      subscriptionModel,
      subscriptionBoundary,
    );
    specialSetup.replaceChildren(subscriptionGuide);
    const groups = document.querySelector('#connection-provider-groups');
    groups.replaceChildren();
    const accessGrid = document.createElement('div');
    accessGrid.className = 'access-choice-grid';
    for (const fixture of [
      ['Claude 官方订阅', '使用 Claude Code 已有的官方登录', false],
      ['ChatGPT 官方订阅', '授权后自动配置本机 Proxy API', true],
      ['国产模型', 'DeepSeek、千问、GLM 等国内服务', false],
      ['API / 中转站', '填写已有密钥、端点或中转站', false],
    ]) {
      const card = document.createElement('button');
      card.className = 'access-choice-card';
      card.classList.toggle('access-choice-card--selected', fixture[2]);
      card.type = 'button';
      card.setAttribute('aria-pressed', String(fixture[2]));
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = fixture[0];
      const detail = document.createElement('small');
      detail.textContent = fixture[1];
      copy.append(title, detail);
      const check = document.createElement('span');
      check.className = 'access-choice-card__check';
      check.textContent = '✓';
      card.append(copy, check);
      if (fixture[2]) {
        const current = document.createElement('small');
        current.className = 'access-choice-card__current';
        current.textContent = '当前配置';
        card.append(current);
      }
      accessGrid.append(card);
    }
    groups.append(accessGrid);
    const historyList = document.querySelector('#connection-history-list');
    historyList.replaceChildren();
    const historyItem = document.createElement('li');
    historyItem.className = 'connection-history__item';
    historyItem.dataset.selected = 'false';
    const historyRestore = document.createElement('button');
    historyRestore.className = 'connection-history__restore';
    historyRestore.type = 'button';
    const historyTitle = document.createElement('strong');
    historyTitle.textContent = '本机转换器 / 模型网关';
    const historyTitleRow = document.createElement('span');
    historyTitleRow.className = 'connection-history__title-row';
    const historySelectedMark = document.createElement('span');
    historySelectedMark.className = 'connection-history__selected-mark';
    historySelectedMark.textContent = '✓';
    historyTitleRow.append(historyTitle, historySelectedMark);
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
    historyRestore.append(historyTitleRow, historyParameters, historyMeta);
    const historyDelete = document.createElement('button');
    historyDelete.className = 'connection-history__delete';
    historyDelete.type = 'button';
    historyDelete.textContent = '×';
    historyItem.append(historyRestore, historyDelete);
    historyList.append(historyItem);
    document.querySelector('#connection-history-empty').hidden = true;
    document.querySelector('#connection-history-count').textContent =
      '1 条历史配置 · 点击恢复全部参数';
    const historyDialogList = document.querySelector('[data-history-dialog-list="api"]');
    historyDialogList.replaceChildren(
      ...Array.from({ length: 4 }, (_, index) => {
        const clone = historyItem.cloneNode(true);
        clone.querySelector('strong').textContent = [
          '研发中转站',
          '本机 Claude Code Router',
          '团队 OpenAI 网关',
          '备用 API 路由',
        ][index];
        return clone;
      }),
    );
    historyDialogList.hidden = false;
    document.querySelector('[data-history-dialog-empty="api"]').hidden = true;
    document.querySelector('[data-history-dialog-count="api"]').textContent = '4 条';
    document.querySelector('#connection-history-dialog-summary').textContent =
      '当前项目共 4 条接入记录';
    document.querySelector('#current-connection').dataset.kind = 'api';
    document.querySelector('#current-connection-name').textContent = '研发中转站';
    document.querySelector('#current-connection-metadata').textContent =
      '接口：https://gateway.example.com/anthropic/ · API 凭据已配置';
    document.querySelector('.control-panel').scrollTop = 0;
    document.querySelector('[data-rail-page="connection"]').style.animation = 'none';
    for (const button of document.querySelectorAll('[data-rail-tab]')) {
      button.classList.toggle(
        'activity-rail__button--active',
        button.dataset.railTab === 'connection',
      );
    }
  `);
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const snapshot = (await captureSettledPage()).toPNG();
      writeFileSync(path.join(outputDirectory, `connection-choice-${themeId}-1180.png`), snapshot);
      if (themeId === 'claude') {
        writeFileSync(path.join(outputDirectory, 'connection-1180.png'), snapshot);
      }
    }

    window.setSize(820, 640);
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      writeFileSync(
        path.join(outputDirectory, `connection-choice-${themeId}-820.png`),
        (await captureSettledPage()).toPNG(),
      );
      await window.webContents.executeJavaScript(`
        document.querySelector('.connection-wizard-actions').scrollIntoView({ block: 'end' });
      `);
      writeFileSync(
        path.join(outputDirectory, `connection-actions-${themeId}-820.png`),
        (await captureSettledPage()).toPNG(),
      );
      await window.webContents.executeJavaScript(`
        document.querySelector('.control-panel').scrollTop = 0;
      `);
    }
    window.setSize(1180, 760);
    await window.webContents.executeJavaScript(applyQaTheme('claude'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    await window.webContents.executeJavaScript(`
    document.querySelector('[data-connection-wizard-step="choice"]').hidden = true;
    document.querySelector('[data-connection-wizard-step="choice"]').classList.remove('connection-wizard-step--active', 'connection-wizard-step--leaving');
    document.querySelector('[data-connection-wizard-step="configure"]').hidden = false;
    document.querySelector('[data-connection-wizard-step="configure"]').classList.remove('connection-wizard-step--leaving');
    document.querySelector('[data-connection-wizard-step="configure"]').classList.add('connection-wizard-step--active');
    document.querySelector('[data-connection-wizard-step="configure"]').style.animation = 'none';
    delete document.querySelector('#connection-wizard-viewport').dataset.direction;
    document.querySelector('#connection-wizard-progress-choice').dataset.state = 'completed';
    document.querySelector('#connection-wizard-progress-configure').dataset.state = 'active';
    document.querySelector('#connection-wizard-previous').disabled = false;
    document.querySelector('#connection-wizard-status').textContent = 'ChatGPT 官方订阅 · 配置与验证';
    document.querySelector('#connection-provider-special').scrollIntoView({ block: 'start' });
  `);
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const snapshot = (await captureSettledPage()).toPNG();
      writeFileSync(
        path.join(outputDirectory, `connection-subscription-setup-${themeId}-1180.png`),
        snapshot,
      );
      if (themeId === 'claude') {
        writeFileSync(
          path.join(outputDirectory, 'connection-subscription-setup-1180.png'),
          snapshot,
        );
      }
    }
    await window.webContents.executeJavaScript(applyQaTheme('claude'));

    await window.webContents.executeJavaScript(`
    document.querySelector('#connection-history').scrollIntoView({ block: 'start' });
  `);
    await new Promise((resolve) => setTimeout(resolve, 80));
    writeFileSync(
      path.join(outputDirectory, 'connection-history-1180.png'),
      (await captureSettledPage()).toPNG(),
    );

    await window.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#connection-history-dialog');
        if (!dialog.open) dialog.showModal();
        document.querySelector('#connection-history-dialog-track').style.transform =
          'translate3d(-300%, 0, 0)';
        for (const tab of document.querySelectorAll('#connection-history-tabs [role="tab"]')) {
          const selected = tab.dataset.historyCategory === 'api';
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
        }
        for (const panel of document.querySelectorAll('#connection-history-dialog [role="tabpanel"]')) {
          const selected = panel.dataset.historyCategory === 'api';
          panel.setAttribute('aria-hidden', String(!selected));
          panel.toggleAttribute('inert', !selected);
        }
        const selectedItem = document.querySelector('[data-history-dialog-list="api"] .connection-history__item');
        selectedItem.dataset.selected = 'true';
        selectedItem.querySelector('.connection-history__restore').setAttribute('aria-pressed', 'true');
        const selection = document.querySelector('#connection-history-dialog-selection');
        selection.hidden = false;
        selection.textContent = '当前选择：研发中转站';
        const finish = document.querySelector('#finish-connection-history');
        finish.dataset.mode = 'confirm';
        finish.textContent = '完成';
        finish.classList.remove('button--quiet');
        finish.classList.add('button--primary');
      })();
    `);
    await new Promise((resolve) => setTimeout(resolve, 420));
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      writeFileSync(
        path.join(outputDirectory, `connection-history-dialog-${themeId}-1180.png`),
        (await captureSettledPage()).toPNG(),
      );
    }
    window.setSize(820, 640);
    await window.webContents.executeJavaScript(applyQaTheme('claude'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(
      path.join(outputDirectory, 'connection-history-dialog-claude-820.png'),
      (await captureSettledPage()).toPNG(),
    );
    window.setSize(1180, 760);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await window.webContents.executeJavaScript(`
      document.querySelector('#connection-history-dialog').close();
    `);
    // A hidden BrowserWindow does not necessarily paint during a timer-only wait. Force and discard
    // one settled frame so the dialog's discrete top-layer exit finishes before recovery captures.
    await captureSettledPage();

    await window.webContents.executeJavaScript(`
      (() => {
        const normalSelectors = [
          '.connection-heading__intro',
          '#open-connection-history',
          '#connection-wizard-progress',
          '#connection-advice',
          '#environment-setup',
          '#connection-wizard-viewport',
          '#connection-wizard-actions',
        ];
        for (const selector of normalSelectors) {
          const surface = document.querySelector(selector);
          surface.dataset.visualWasHidden = String(surface.hidden);
          surface.dataset.visualWasInert = String(surface.hasAttribute('inert'));
          surface.hidden = true;
          surface.toggleAttribute('inert', true);
        }
        const recovery = document.querySelector('#connection-history-recovery');
        recovery.hidden = false;
        recovery.removeAttribute('inert');
        recovery.dataset.phase = 'failure';
        document.querySelector('#connection-history-recovery-kicker').textContent = '接入未完成';
        document.querySelector('#connection-history-recovery-title').textContent =
          '研发中转站 接入失败';
        document.querySelector('#connection-history-recovery-detail').textContent =
          '历史配置未通过连接测试，请检查网络、认证方式与模型标识后重新接入。';
        const details = document.querySelector('#connection-history-recovery-details');
        details.replaceChildren();
        for (const [label, status, detail] of [
          ['接口地址', '通过', '200 · /v1/messages 可访问'],
          ['身份认证', '通过', '网关接受了当前认证方式。'],
          ['模型响应', '失败', '模型返回的消息格式不完整，请检查模型标识。'],
        ]) {
          const item = document.createElement('li');
          item.dataset.status = status === '失败' ? 'failed' : 'passed';
          const heading = document.createElement('span');
          const strong = document.createElement('strong');
          strong.textContent = label;
          const em = document.createElement('em');
          em.textContent = status;
          heading.append(strong, em);
          const small = document.createElement('small');
          small.textContent = detail;
          item.append(heading, small);
          details.append(item);
        }
        document.querySelector('#cancel-connection-history-recovery').hidden = true;
        document.querySelector('#retry-connection-history-recovery').hidden = false;
        document.querySelector('#return-from-connection-history-recovery').hidden = false;
      })();
    `);
    for (const themeId of themeOrder) {
      await window.webContents.executeJavaScript(applyQaTheme(themeId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      writeFileSync(
        path.join(outputDirectory, `connection-history-recovery-${themeId}-1180.png`),
        (await captureSettledPage()).toPNG(),
      );
    }
    await window.webContents.executeJavaScript(`
      (() => {
        document.querySelector('#connection-history-recovery').hidden = true;
        for (const surface of document.querySelectorAll('[data-visual-was-hidden]')) {
          surface.hidden = surface.dataset.visualWasHidden === 'true';
          surface.toggleAttribute('inert', surface.dataset.visualWasInert === 'true');
          delete surface.dataset.visualWasHidden;
          delete surface.dataset.visualWasInert;
        }
      })();
    `);
    await window.webContents.executeJavaScript(applyQaTheme('claude'));

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
    for (const settingsPage of ['proxy', 'router']) {
      await window.webContents.executeJavaScript(`
      for (const tab of document.querySelectorAll('[data-settings-tab]')) {
        const selected = tab.dataset.settingsTab === '${settingsPage}';
        tab.classList.toggle('settings-tab--active', selected);
        tab.setAttribute('aria-selected', String(selected));
      }
      for (const panel of document.querySelectorAll('[data-settings-panel]')) {
        panel.classList.toggle(
          'settings-panel--active',
          panel.dataset.settingsPanel === '${settingsPage}',
        );
      }
      document.querySelector('.settings-panels').scrollTop = 0;
    `);
      for (const themeId of themeOrder) {
        await window.webContents.executeJavaScript(applyQaTheme(themeId));
        await new Promise((resolve) => setTimeout(resolve, 80));
        writeFileSync(
          path.join(outputDirectory, `global-settings-${settingsPage}-${themeId}-1180.png`),
          (await captureSettledPage()).toPNG(),
        );
      }
    }
    await window.webContents.executeJavaScript(applyQaTheme('claude'));
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
