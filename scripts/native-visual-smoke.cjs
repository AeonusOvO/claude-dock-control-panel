const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const typescript = require('typescript');

const root = path.join(__dirname, '..');
const outputRoot = path.join(root, 'dist', 'visual-qa');
const isolatedUserData = path.join(root, 'dist', '.electron-native-visual-smoke');
app.setPath('userData', isolatedUserData);

const loadThemeDefinitions = () => {
  const source = readFileSync(path.join(root, 'src', 'shared', 'terminal-themes.ts'), 'utf8');
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
const themes = ['claude', 'telegram', 'graphite', 'midnight'];
const captures = [];

const applyTheme = (theme) => `
  (() => {
    const definition = ${JSON.stringify(TERMINAL_THEMES[theme])};
    const mapping = ${JSON.stringify(SHELL_CSS_VARIABLES)};
    for (const [field, property] of Object.entries(mapping)) {
      document.documentElement.style.setProperty(property, definition.shell[field]);
    }
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.documentElement.dataset.appearance = definition.appearance;
    document.documentElement.style.colorScheme = definition.appearance;
    document.querySelector('#terminal-theme').value = ${JSON.stringify(theme)};
    document.querySelector('#settings-theme').value = ${JSON.stringify(theme)};
  })()
`;

const installFixtures = String.raw`
  (() => {
    document.documentElement.dataset.nativeQa = 'true';
    const qaStyle = document.createElement('style');
    qaStyle.textContent = [
      "html[data-native-qa='true'] #terminal-shell { animation: none !important; grid-template-rows: var(--toolbar-h) minmax(0, 1fr) !important; opacity: 1 !important; }",
      "html[data-native-qa='true'] #terminal-shell > :is(.terminal-stage, .terminal-composer, .terminal-footer) { display: none !important; }",
      "html[data-native-qa='true'] #native-conversation { animation: none !important; display: grid !important; opacity: 1 !important; transform: none !important; }",
      "html[data-native-qa='true'] #runtime-activity-panel[data-state='open'] { animation: none !important; opacity: 1 !important; transform: none !important; }",
    ].join('\\n');
    document.head.append(qaStyle);
    const byId = (id) => document.getElementById(id);
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const activateProjects = () => {
      for (const page of document.querySelectorAll('[data-rail-page]')) {
        page.classList.toggle('rail-page--active', page.dataset.railPage === 'projects');
      }
      for (const button of document.querySelectorAll('[data-rail-tab]')) {
        button.classList.toggle('activity-rail__button--active', button.dataset.railTab === 'projects');
      }
    };
    const button = (label, primary = false) => {
      const result = el('button', '', label);
      result.type = 'button';
      result.dataset.primary = String(primary);
      return result;
    };
    const tool = (name, status, summary, open = false) => {
      const details = el('details', 'native-tool');
      details.dataset.status = status;
      details.open = open;
      const heading = el('summary');
      heading.append(
        el('span', 'native-tool__state'),
        el('span', 'native-tool__name', summary || name),
        el('span', 'native-tool__status', status === 'running' ? '运行中' : status === 'failed' ? '失败' : '已完成'),
      );
      const body = el('div', 'native-tool__details');
      body.append(el('pre', '', JSON.stringify({ tool: name, path: 'src/main/main.ts' }, null, 2)));
      if (status !== 'running') body.append(el('pre', '', status === 'failed' ? '权限不足，未修改任何文件。' : '已完成并通过类型检查。'));
      details.append(heading, body);
      return details;
    };
    const message = (role, bodyBuilder, streaming = false) => {
      const article = el('article', 'native-message native-message--' + role);
      if (streaming) article.classList.add('native-message--streaming');
      article.append(el('strong', 'native-message__label', role === 'user' ? '你' : role === 'assistant' ? 'Claude' : '系统'));
      const body = el('div', 'native-message__body');
      bodyBuilder(body);
      article.append(body);
      return article;
    };
    const markdown = (html) => {
      const node = el('div', 'chat-message__markdown');
      node.innerHTML = html;
      return node;
    };
    const buildHistory = (railWidth = 320, scroll = true) => {
      document.documentElement.style.setProperty('--rail-w', railWidth + 'px');
      byId('runtime-picker').disabled = false;
      byId('runtime-claude').checked = true;
      byId('runtime-codex').checked = false;
      const list = byId('project-list');
      list.replaceChildren();
      const folder = el('section', 'project-folder');
      folder.dataset.open = 'true';
      folder.dataset.expanded = 'true';
      folder.dataset.active = 'true';
      const header = el('div', 'project-folder__header');
      const disclosure = button('');
      disclosure.className = 'project-folder__disclosure';
      disclosure.setAttribute('aria-expanded', 'true');
      disclosure.append(el('span', 'project-folder__chevron', '▾'));
      const copy = el('span', 'project-folder__copy');
      copy.append(el('strong', '', 'ClaudeDock 原生对话架构与安全恢复'), el('span', '', '1 个对话进行中'));
      disclosure.append(copy);
      const actions = el('div', 'project-folder__actions');
      const plus = button('+'); plus.className = 'project-folder__action';
      const close = button('×'); close.className = 'project-folder__action project-folder__action--close';
      actions.append(plus, close);
      header.append(disclosure, actions);
      const body = el('div', 'project-folder__body');
      const live = el('div', 'conversation-item');
      live.dataset.active = 'true'; live.dataset.phase = 'running';
      const select = button(''); select.className = 'conversation-item__select';
      select.append(el('span', 'conversation-item__status'), el('span', 'conversation-item__label', '原生对话 · 发布前完整检查'), el('span', 'conversation-item__phase', '运行中'));
      live.append(select);
      body.append(live, el('span', 'project-folder__hint', '历史对话（运行中的 UUID 已自动隐藏）'));
      const history = el('div', 'project-folder__history');
      history.setAttribute('role', 'list');
      const names = [
        '修复窗口缩放时 Claude 螃蟹图标重复与边框截断',
        '模型能力档位与 Ultra Code 呈现规则',
        'Windows 强制重启后的安全恢复策略',
        '主题切换与代码差异背景实时同步',
        '图片粘贴、拖放与安全附件预览',
        '任务与下载中心真实进度呈现',
        '历史会话单一 owner 与失败回滚',
      ];
      names.push(
        'Agent SDK 启动器与 NPM 安装路径兼容',
        '安全会话按钮状态单一来源与主题悬停色',
        '模型接入成功后的原生会话启动事务',
        '后台活动权威空快照与失联任务处理',
        '任务与下载中心的阶段和真实进度',
        '发布候选版安装包与回滚验证',
      );
      names.forEach((name, index) => {
        const row = el('div', 'history-item');
        const choose = button(''); choose.className = 'history-item__select';
        choose.append(el('span', 'history-item__icon', '◷'), el('span', 'history-item__label', name), el('span', 'history-item__time', index === 0 ? '刚刚' : index + 1 + ' 天前'));
        const remove = button('×'); remove.className = 'history-item__delete';
        row.append(choose, remove); history.append(row);
      });
      if (!scroll) history.style.maxHeight = 'none';
      body.append(history); folder.append(header, body); list.append(folder);
    };
    const setControls = () => {
      const model = byId('native-model-control');
      model.replaceChildren(new Option('Claude Opus 4.6', 'claude-opus-4-6'), new Option('Claude Haiku 4.5', 'claude-haiku-4-5'));
      model.value = 'claude-opus-4-6'; model.disabled = false;
      const effort = byId('native-effort-control');
      effort.replaceChildren(new Option('Ultra Code', 'ultracode'), new Option('最大', 'max'), new Option('更深 · X-High', 'xhigh'));
      effort.value = 'ultracode'; effort.disabled = false;
      const fast = byId('native-fast-control'); fast.disabled = false; fast.dataset.state = 'requested'; fast.setAttribute('aria-pressed', 'true'); fast.textContent = 'Fast · 已请求';
      const permission = byId('native-permission-control');
      permission.replaceChildren(new Option('逐项确认', 'default'), new Option('规划模式', 'plan'));
      permission.disabled = false;
    };
    const base = ({ state = 'success', railWidth = 320, scroll = true } = {}) => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      activateProjects(); buildHistory(railWidth, scroll);
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      const summaryPanel = byId('runtime-activity-panel');
      summaryPanel.hidden = true; summaryPanel.dataset.state = 'closed';
      const diagnosticPanel = byId('terminal-diagnostic');
      diagnosticPanel.hidden = true; diagnosticPanel.dataset.state = 'closed'; diagnosticPanel.setAttribute('aria-hidden', 'true');
      const diagnosticScrim = byId('terminal-diagnostic-scrim');
      diagnosticScrim.hidden = true; diagnosticScrim.dataset.state = 'closed';
      byId('terminal-shell').hidden = false;
      byId('chat-shell').hidden = true;
      byId('terminal-shell').classList.add('terminal-shell--native');
      byId('terminal-project').textContent = 'ClaudeDock · 原生对话';
      const native = byId('native-conversation');
      native.dataset.state = 'open'; native.setAttribute('aria-hidden', 'false');
      byId('native-terminal-toggle').setAttribute('aria-pressed', 'true');
      byId('native-terminal-toggle-label').textContent = '返回终端';
      byId('native-recovery-stack').hidden = true;
      byId('native-interaction-stack').replaceChildren();
      byId('native-attachment-queue').hidden = true;
      setControls();
      const messages = byId('native-conversation-messages');
      const empty = byId('native-conversation-empty');
      messages.replaceChildren(empty);
      empty.hidden = state !== 'empty';
      byId('native-composer-status').textContent = state === 'loading' ? 'Claude 正在处理' : state === 'failure' ? '接入配置不可用 · 请打开配置检查' : '可以继续对话';
      byId('native-stop').hidden = state !== 'loading';
      if (state === 'empty') return;
      const user = message('user', (body) => body.append(markdown('<p>请完成 <strong>ClaudeDock 5.0</strong> 原生对话迁移，并保留原始空白、代码围栏与工具顺序。</p>')));
      const assistant = message('assistant', (body) => {
        body.append(markdown('<h2>实施进度</h2><p>原生适配器已经接管结构化事件。下面的代码块会保留围栏与换行：</p><pre class="markdown-code"><code>const owner = [runtime, project, uuid];\nawait ownerRegistry.claim(owner);</code></pre><hr><p>运行中与高风险工具默认展开，普通成功项保持折叠。</p>'));
        body.append(tool('Read', 'succeeded', '读取运行时配置', false));
        body.append(tool('Edit', state === 'failure' ? 'failed' : state === 'loading' ? 'running' : 'succeeded', state === 'failure' ? '写入恢复日志失败' : '更新原生会话服务', true));
      }, state === 'loading');
      messages.append(user, assistant);
    };
    const interaction = (kind) => {
      base();
      const stack = byId('native-interaction-stack');
      const card = el('form', 'native-interaction native-interaction--' + kind);
      const head = el('div', 'native-interaction__head');
      head.append(el('span', 'native-interaction__eyebrow', kind === 'permission' ? '权限确认' : '需要你的选择'), el('strong', '', kind === 'permission' ? '允许修改发布配置吗？' : '请选择异常恢复策略'));
      head.append(el('p', '', '这项操作会影响当前项目，但不会接触系统级 API 路由。'));
      card.append(head);
      if (kind === 'permission') card.append(el('pre', 'native-interaction__payload', '{\n  "tool": "Edit",\n  "file": "package.json"\n}'));
      else {
        const fieldset = el('fieldset', 'native-interaction__options');
        fieldset.append(el('legend', '', '恢复策略'));
        [['保留现有会话', '切换到已经运行的 owner，不重复启动。'], ['替换旧 owner', '先安全停止旧 owner，再精确恢复 UUID。']].forEach(([title, description], index) => {
          const label = el('label');
          const input = el('input'); input.type = 'radio'; input.name = 'strategy'; input.checked = index === 0;
          const copy = el('span'); copy.append(el('strong', '', title), el('small', '', description));
          label.append(input, copy); fieldset.append(label);
        });
        card.append(fieldset);
      }
      const actions = el('div', 'native-interaction__actions');
      const actionButtons = [button('取消'), button(kind === 'permission' ? '拒绝' : '提交'), button(kind === 'permission' ? '允许一次' : '继续', true)];
      actionButtons.forEach((action, index) => { action.className = index === 2 ? 'button button--compact button--primary' : 'button button--compact'; });
      actions.append(...actionButtons);
      card.append(actions); stack.append(card);
    };
    const recovery = () => {
      base();
      const stack = byId('native-recovery-stack'); stack.hidden = false; stack.replaceChildren();
      const card = el('article', 'native-recovery-card');
      const copy = el('div'); copy.append(el('span', '', '上次运行异常中断 · 结果需要核对'), el('strong', '', '发布前检查与 Windows 强制重启恢复'), el('p', '', '这段输入不会自动重发；继续前请先核对 Claude JSONL。'));
      const actions = el('div', 'native-recovery-card__actions'); actions.append(button('继续原对话'), button('恢复待确认文本'), button('丢弃记录'));
      [...actions.children].forEach((action) => { action.className = 'button button--compact'; });
      actions.lastElementChild.className = 'button button--compact button--danger native-recovery-card__discard'; card.append(copy, actions); stack.append(card);
    };
    const attachments = () => {
      base();
      const queue = byId('native-attachment-queue'); queue.hidden = false; queue.replaceChildren();
      ['architecture-overview.png', '窗口缩放问题截图-超长中文文件名.png'].forEach((name, index) => {
        const card = el('article', 'native-attachment');
        const preview = el('div', 'native-attachment__preview'); preview.append(el('span', '', index ? 'PNG' : 'IMG'));
        const copy = el('div'); copy.append(el('strong', '', name), el('small', '', index ? 'image/png · 2.4 MB' : 'image/png · 840 KB'));
        card.append(preview, copy, button('×')); queue.append(card);
      });
      byId('native-composer-input').value = '请对照这两张截图检查四个主题下的布局和动效。';
    };
    const themeMenu = () => {
      base();
      const shell = byId('terminal-theme').closest('.select');
      shell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    };
    const runtimeSelection = () => {
      base();
      byId('runtime-claude').checked = false;
      byId('runtime-codex').checked = true;
    };
    const summary = () => {
      base();
      const panel = byId('runtime-activity-panel'); panel.hidden = false; panel.dataset.state = 'open';
      byId('runtime-activity-trigger').setAttribute('aria-expanded', 'true');
      byId('runtime-activity-label').textContent = '活动 2';
      byId('runtime-activity-summary').textContent = 'Claude 正在处理 · 2 项活动';
      byId('runtime-environment-meta').textContent = '原生对话';
      byId('runtime-task-meta').textContent = '2 运行 · 1 完成';
      byId('runtime-source-meta').textContent = '2 项';
      const icons = {
        background: 'M12 4v8l5 3M4.8 17.2a9 9 0 1 0 .3-10.7',
        foreground: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 2',
        interface: 'M4 5h16v11H4zM8 20h8M12 16v4',
        model: 'M12 3v3M12 18v3M3 12h3M18 12h3M8.5 8.5h7v7h-7z',
        project: 'M3.5 7h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z',
        source: 'M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7.7 6.1 16.3 17.9',
        subagent: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16 13a2.5 2.5 0 1 0 0-5M3.5 20c.5-4 8.5-4 9 0M13 17c2.8-1.4 6.8-.5 7.5 2.5',
        workflow: 'M6 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 23a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 3h3a4 4 0 0 1 4 4v4M15 13v4a4 4 0 0 1-4 4H8',
      };
      const icon = (kind) => {
        const mount = el('span', 'runtime-summary-icon'); mount.setAttribute('aria-hidden', 'true');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', icons[kind]); svg.append(path); mount.append(svg); return mount;
      };
      const row = ({ action, detail, environment = false, iconKind, status, statusLabel, title }) => {
        const item = el('li', 'runtime-summary-row' + (environment ? ' runtime-summary-row--environment' : ''));
        if (status) item.dataset.status = status;
        const copy = el('div', 'runtime-summary-row__copy');
        const titleLine = el('div', 'runtime-summary-row__title'); titleLine.append(el('strong', '', title));
        if (statusLabel) titleLine.append(el('span', 'runtime-summary-row__tag', statusLabel));
        copy.append(titleLine); if (detail) copy.append(el('span', '', detail));
        item.append(icon(iconKind), copy);
        if (action) {
          const trailing = el('div', 'runtime-summary-row__trailing');
          trailing.append(action); item.append(trailing);
        }
        return item;
      };
      byId('runtime-environment-list').replaceChildren(
        row({ environment: true, iconKind: 'project', title: '项目', detail: 'ClaudeDock' }),
        row({ environment: true, iconKind: 'interface', title: '界面', detail: '原生对话 · Agent SDK' }),
        row({ environment: true, iconKind: 'model', title: '模型', detail: 'Claude Opus 4.6' }),
        row({ environment: true, iconKind: 'foreground', title: '前台', detail: 'Claude 正在处理' }),
      );
      const stop = button('停止'); stop.className = 'button button--compact button--quiet runtime-summary-row__action';
      byId('runtime-task-list').replaceChildren(
        row({ action: stop, detail: '子智能体 · 完成后返回主对话', iconKind: 'subagent', status: 'running', statusLabel: '运行中', title: '核对四主题视觉矩阵' }),
        row({ detail: '工作流 · 安装包签名检查', iconKind: 'workflow', status: 'waiting', statusLabel: '等待中', title: '发布前完整验证' }),
        row({ detail: '后台任务 · 本地执行', iconKind: 'background', status: 'completed', statusLabel: '已完成', title: '生成真实 Electron 截图' }),
      );
      byId('runtime-source-list').replaceChildren(
        row({ iconKind: 'source', title: 'Claude Agent SDK' }),
        row({ iconKind: 'source', title: '本机 Claude Code CLI' }),
      );
      byId('runtime-process-list').replaceChildren();
    };
    const diagnostic = () => {
      base();
      const scrim = byId('terminal-diagnostic-scrim'); scrim.hidden = false; scrim.dataset.state = 'open';
      const panel = byId('terminal-diagnostic'); panel.hidden = false; panel.dataset.state = 'open'; panel.setAttribute('aria-hidden', 'false');
      byId('terminal-diagnostic-title').textContent = '项目终端未能启动';
      byId('terminal-diagnostic-message').textContent = '当前原生对话仍可使用。运行诊断后可以重试安全终端连接。';
      const result = byId('terminal-diagnostic-result'); result.hidden = false; result.textContent = 'POWERSHELL_UNAVAILABLE · 工作目录可访问 · 未读取凭据或会话正文';
    };
    const plan = () => {
      base();
      const dialog = byId('native-plan-dialog');
      byId('native-plan-title').textContent = 'ClaudeDock 5.0 原生对话实施计划';
      byId('native-plan-content').innerHTML = '<h1>发布前计划检查</h1><p>确认以下步骤后再批准实施：</p><ol><li>结构化适配器与单一 owner</li><li>恢复日志、图片安全与命令矩阵</li><li>四主题视觉矩阵与真实 Electron 检查</li><li>完整测试、打包和发布审计</li></ol><pre class="markdown-code"><code>unknown state → draft only\nnever auto-resend</code></pre><blockquote>不确定状态不会自动重发提示词或工具操作。</blockquote>';
      if (!dialog.open) dialog.showModal(); dialog.dataset.state = 'open';
    };
    const updates = () => {
      base();
      const dialog = byId('download-center-dialog'); if (!dialog.open) dialog.showModal();
      byId('download-center-empty').hidden = true; byId('download-active-section').hidden = false;
      byId('download-active-summary').textContent = '2 项进行中';
      const list = byId('download-operation-list'); list.replaceChildren();
      const operation = el('article', 'download-task'); operation.dataset.state = 'installing';
      const header = el('header'); const identity = el('div'); identity.append(el('strong', '', '更新 Claude Code（npm）'), el('span', 'download-task__state', '校验安装结果 · 队列 2/4'));
      const progress = byId('download-progress-template').content.firstElementChild.cloneNode(true); progress.dataset.indeterminate = 'true'; progress.querySelector('.download-progress__value').textContent = '…'; progress.querySelector('.download-progress__linear > span').style.width = '34%';
      header.append(identity, progress); operation.append(header);
      const metrics = el('dl', 'download-task__metrics download-task__metrics--operation');
      [['对象', 'Claude Code'], ['已用时间', '01:42'], ['类型', 'claude-code']].forEach(([term, value]) => { const row = el('div'); row.append(el('dt', '', term), el('dd', '', value)); metrics.append(row); });
      operation.append(metrics, el('pre', 'download-task__log', '检测安装方式：npm\n已选择 registry.npmjs.org\nnpm 下载与写入中（总量未知）\n正在校验 claude --version'));
      list.append(operation);
    };
    const launchButton = () => {
      activateProjects();
      buildHistory(320, true);
      byId('native-conversation').style.setProperty('display', 'none', 'important');
      byId('terminal-shell').classList.remove('terminal-shell--native');
      const workbench = byId('claude-workbench');
      workbench.classList.add('claude-workbench--open');
      workbench.setAttribute('aria-hidden', 'false');
      for (const page of workbench.querySelectorAll('.workbench-page')) {
        page.classList.toggle('workbench-page--active', page.dataset.workbenchPage === 'session');
      }
      const launch = byId('launch-new');
      launch.disabled = false;
      launch.removeAttribute('aria-busy');
      launch.dataset.launchBlocked = 'false';
      launch.textContent = '新建安全会话';
      launch.scrollIntoView({ block: 'center' });
    };
    window.__nativeQa = { attachments, base, diagnostic, interaction, launchButton, plan, recovery, runtimeSelection, summary, themeMenu, updates };
  })()
`;

const freezeAnimations = async (window, progress) => {
  await window.webContents.executeJavaScript(`
    (() => {
      const animations = document.getAnimations({ subtree: true });
      for (const animation of animations) {
        const duration = Number(animation.effect?.getComputedTiming().duration ?? 0);
        animation.pause();
        animation.currentTime = duration * ${progress};
      }
      return animations.length;
    })()
  `);
};

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      height: 760,
      show: false,
      useContentSize: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      width: 1180,
    });
    await window.loadFile(path.join(root, 'dist', 'renderer', 'index.html'));
    await window.webContents.executeJavaScript(installFixtures);

    const capture = async (feature, file, metadata = {}) => {
      const directory = path.join(outputRoot, feature);
      mkdirSync(directory, { recursive: true });
      window.webContents.invalidate();
      // Hidden BrowserWindows throttle animation clocks until the first compositor frame. Prime one
      // frame before waiting, otherwise a "settled" screenshot can accidentally capture 30–60% of
      // an entrance even after the wall-clock duration elapsed.
      await window.capturePage();
      // The Telegram theme intentionally has the longest entrance. Settled captures wait beyond the
      // theme token; paused animation captures remain deterministic because their timelines are held.
      await new Promise((resolve) => setTimeout(resolve, 440));
      // capturePage can return the preceding compositor frame in a hidden window. Discard one final
      // frame, then capture again after a short compositor turn so every file reflects its own scene.
      await window.capturePage();
      await new Promise((resolve) => setTimeout(resolve, 34));
      window.webContents.invalidate();
      const image = await window.capturePage();
      const png = image.toPNG();
      if (png.length < 1000) throw new Error(`Invalid visual capture: ${feature}/${file}`);
      writeFileSync(path.join(directory, file), png);
      const dom = await window.webContents.executeJavaScript(`
      (() => {
        const view = document.querySelector('#native-conversation');
        const messages = document.querySelector('#native-conversation-messages');
        const firstMessage = messages.querySelector('.native-message');
        const composer = document.querySelector('#native-composer');
        const summary = document.querySelector('#runtime-activity-panel');
        const diagnostic = document.querySelector('#terminal-diagnostic');
        const runtimeCards = [...document.querySelectorAll('.runtime-option')];
        const selectedRuntime = document.querySelector('.runtime-option:has(input:checked)');
        const projectFolder = document.querySelector('.project-folder');
        const historyRows = [...document.querySelectorAll('.history-item')];
        const historyScroller = document.querySelector('.project-folder__history');
        const launchButton = document.querySelector('#launch-new');
        const rect = view.getBoundingClientRect();
        return {
          composerDisplay: getComputedStyle(composer).display,
          composerHeight: Math.round(composer.getBoundingClientRect().height),
          composerRowHeight: Math.round(composer.querySelector('.native-composer__row').getBoundingClientRect().height),
          composerTop: Math.round(composer.getBoundingClientRect().top),
          diagnosticHidden: diagnostic.hidden,
          firstMessageColor: firstMessage ? getComputedStyle(firstMessage).color : '',
          firstMessageDisplay: firstMessage ? getComputedStyle(firstMessage).display : '',
          firstMessageOpacity: firstMessage ? getComputedStyle(firstMessage).opacity : '',
          firstMessageTop: firstMessage ? Math.round(firstMessage.getBoundingClientRect().top) : -1,
          messageCount: messages.querySelectorAll('.native-message').length,
          messagesHeight: Math.round(messages.getBoundingClientRect().height),
          messagesScrollTop: Math.round(messages.scrollTop),
          innerWidth: window.innerWidth,
          historyRows: historyRows.map((row) => {
            const rowRect = row.getBoundingClientRect();
            const label = row.querySelector('.history-item__label').getBoundingClientRect();
            const time = row.querySelector('.history-item__time').getBoundingClientRect();
            const remove = row.querySelector('.history-item__delete').getBoundingClientRect();
            return {
              deleteWidth: Math.round(remove.width),
              labelHeight: Math.round(label.height),
              labelWidth: Math.round(label.width),
              noTailOverlap: label.right <= time.left,
              rowHeight: Math.round(rowRect.height),
              timeWidth: Math.round(time.width),
            };
          }),
          historyClientHeight: Math.round(historyScroller?.clientHeight ?? 0),
          historyScrollHeight: Math.round(historyScroller?.scrollHeight ?? 0),
          launchBackground: launchButton ? getComputedStyle(launchButton).backgroundColor : '',
          launchColor: launchButton ? getComputedStyle(launchButton).color : '',
          launchDisabled: launchButton?.disabled ?? null,
          launchOpacity: launchButton ? getComputedStyle(launchButton).opacity : '',
          visualViewportWidth: Math.round(window.visualViewport?.width ?? window.innerWidth),
          compactViewport: document.documentElement.dataset.compactViewport ?? '',
          railCollapsed: document.querySelector('.workspace')?.classList.contains('workspace--rail-collapsed') ?? false,
          nativeDisplay: getComputedStyle(view).display,
          nativeHeight: Math.round(rect.height),
          nativeGridRows: getComputedStyle(view).gridTemplateRows,
          nativeOpacity: getComputedStyle(view).opacity,
          nativeState: view.dataset.state,
          projectRuntimeRightDelta: projectFolder && runtimeCards[0]
            ? Math.round(projectFolder.getBoundingClientRect().right - runtimeCards[0].getBoundingClientRect().right)
            : null,
          runtimeCardHeights: runtimeCards.map((card) => Math.round(card.getBoundingClientRect().height)),
          runtimeSelected: selectedRuntime?.querySelector('input')?.value ?? '',
          summaryHidden: summary.hidden,
          dialogs: [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.id),
        };
      })()
    `);
      captures.push({
        dom,
        feature,
        file,
        height: image.getSize().height,
        width: image.getSize().width,
        ...metadata,
      });
    };
    const scene = async (name, options) => {
      await window.webContents.executeJavaScript(
        `window.__nativeQa.${name}(${JSON.stringify(options ?? {})})`,
      );
    };

    if (process.env.CLAUDEDOCK_VISUAL_DEBUG === '1') {
      await window.webContents.executeJavaScript(applyTheme('graphite'));
      await scene('base', { railWidth: 320, state: 'success' });
      await capture('native-conversation', 'debug.png', { scene: 'debug', theme: 'graphite' });
      console.log(JSON.stringify(captures[0], null, 2));
      app.exit(0);
      return;
    }

    for (const theme of themes) {
      await window.webContents.executeJavaScript(applyTheme(theme));
      for (const [width, height] of [
        [820, 640],
        [900, 640],
        [1180, 760],
      ]) {
        window.setContentSize(width, height);
        window.webContents.setZoomFactor(1);
        await scene('base', {
          railWidth: width === 820 ? 270 : width === 900 ? 320 : 560,
          state: 'success',
        });
        await capture('native-conversation', `${theme}-${width}x${height}-success.png`, {
          height,
          railWidth: width === 820 ? 270 : width === 900 ? 320 : 560,
          scene: 'success',
          theme,
          width,
          zoom: 100,
        });
      }
    }

    // The real regression only appeared with a narrow project rail and an active hover tail. Keep a
    // dedicated four-theme capture in addition to the base matrix so title width and crossfade
    // geometry are visible evidence, not merely static CSS assertions.
    for (const theme of themes) {
      await window.webContents.executeJavaScript(applyTheme(theme));
      window.setContentSize(820, 640);
      window.webContents.setZoomFactor(1);
      await scene('base', { railWidth: 270, state: 'success' });
      const point = await window.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.history-item').getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      await capture('sidebar-history', `${theme}-820x640-hover.png`, {
        railWidth: 270,
        scene: 'history-hover',
        theme,
        width: 820,
        zoom: 100,
      });
    }

    for (const theme of themes) {
      await window.webContents.executeJavaScript(applyTheme(theme));
      window.setContentSize(900, 640);
      window.webContents.setZoomFactor(1);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
      await scene('launchButton');
      await capture('safe-launch-button', `${theme}-900x640-normal.png`, {
        interaction: 'normal',
        theme,
      });
      const point = await window.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('#launch-new').getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      await capture('safe-launch-button', `${theme}-900x640-hover.png`, {
        interaction: 'hover',
        theme,
      });
    }

    await window.webContents.executeJavaScript(applyTheme('graphite'));
    window.setContentSize(1180, 760);
    for (const state of ['empty', 'loading', 'failure']) {
      await scene('base', { railWidth: 320, state });
      await capture('native-conversation', `graphite-1180x760-${state}.png`, {
        scene: state,
        theme: 'graphite',
        zoom: 100,
      });
    }
    for (const zoom of [1.25, 1.5, 2]) {
      window.setContentSize(1180, 760);
      window.webContents.setZoomFactor(zoom);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await window.webContents.executeJavaScript(`window.dispatchEvent(new Event('resize'))`);
      await scene('base', { railWidth: 320, state: 'success' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await capture('native-conversation', `graphite-1180x760-zoom-${Math.round(zoom * 100)}.png`, {
        scene: 'success',
        theme: 'graphite',
        zoom: Math.round(zoom * 100),
      });
    }
    window.webContents.setZoomFactor(1);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const componentScenes = [
      ['interaction', 'permission', 'permission'],
      ['interaction', 'question', 'question'],
      ['recovery', undefined, 'recovery'],
      ['attachments', undefined, 'attachments'],
      ['summary', undefined, 'summary'],
      ['runtimeSelection', undefined, 'runtime-picker'],
      ['themeMenu', undefined, 'theme-menu'],
      ['diagnostic', undefined, 'terminal-diagnostic'],
      ['plan', undefined, 'plan'],
      ['updates', undefined, 'updates'],
    ];
    for (const theme of themes) {
      // Chromium can retain a just-closed modal backdrop for several hidden-window compositor
      // frames. A fresh document for every theme (including the first one after the responsive
      // matrix) keeps captures authoritative instead of accepting a ghosted backdrop as evidence.
      await window.loadFile(path.join(root, 'dist', 'renderer', 'index.html'));
      await window.webContents.executeJavaScript(installFixtures);
      await window.webContents.executeJavaScript(applyTheme(theme));
      window.setContentSize(1180, 760);
      for (const [name, argument, feature] of componentScenes) {
        await scene(name, argument);
        await capture(feature, `${theme}-1180x760-open.png`, {
          scene: name,
          state: 'open',
          theme,
          zoom: 100,
        });
        await window.webContents.executeJavaScript(
          `for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()`,
        );
      }
    }

    for (const theme of ['claude', 'telegram']) {
      await window.webContents.executeJavaScript(applyTheme(theme));
      window.setContentSize(1180, 760);
      await scene('base', { railWidth: 320, state: 'success' });
      await window.webContents.executeJavaScript(
        `document.querySelector('#native-send').dataset.sending = 'true'`,
      );
      await freezeAnimations(window, 0.5);
      await capture('composer-theme', `${theme}-1180x760-send-mid.png`, {
        animation: 'send',
        progress: 0.5,
        theme,
      });
    }

    for (const theme of themes) {
      await window.webContents.executeJavaScript(applyTheme(theme));
      window.setContentSize(1180, 760);
      await scene('runtimeSelection');
      await freezeAnimations(window, 0.5);
      await capture('runtime-picker', `${theme}-1180x760-select-mid.png`, {
        animation: 'select',
        progress: 0.5,
        theme,
      });
    }

    await window.webContents.executeJavaScript(applyTheme('telegram'));
    window.setContentSize(1180, 760);
    for (const [name, feature, target] of [
      ['summary', 'summary', '#runtime-activity-panel'],
      ['diagnostic', 'terminal-diagnostic', '#terminal-diagnostic'],
      ['plan', 'plan', '#native-plan-dialog'],
    ]) {
      await scene(name);
      await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(target)}).dataset.state = 'opening'`,
      );
      await freezeAnimations(window, 0.5);
      await capture(feature, `telegram-1180x760-enter-mid.png`, {
        animation: 'enter',
        progress: 0.5,
        theme: 'telegram',
      });
      await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(target)}).dataset.state = 'closing'`,
      );
      await freezeAnimations(window, 0.5);
      await capture(feature, `telegram-1180x760-exit-mid.png`, {
        animation: 'exit',
        progress: 0.5,
        theme: 'telegram',
      });
      await window.webContents.executeJavaScript(
        `for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()`,
      );
    }

    const historyCaptures = captures.filter((capture) => capture.feature === 'sidebar-history');
    for (const capture of historyCaptures) {
      if (capture.dom.historyRows.length !== 13) {
        throw new Error(`${capture.file}: expected 13 history rows`);
      }
      if (capture.dom.historyScrollHeight <= capture.dom.historyClientHeight) {
        throw new Error(`${capture.file}: long history did not become scrollable`);
      }
      if (
        capture.dom.historyRows.some(
          (row) => row.rowHeight < 27 || row.labelHeight > row.rowHeight || !row.noTailOverlap,
        )
      ) {
        throw new Error(`${capture.file}: a history row is compressed or overlaps its tail slot`);
      }
    }
    const launchCaptures = captures.filter((capture) => capture.feature === 'safe-launch-button');
    for (const theme of themes) {
      const normal = launchCaptures.find(
        (capture) => capture.theme === theme && capture.interaction === 'normal',
      );
      const hover = launchCaptures.find(
        (capture) => capture.theme === theme && capture.interaction === 'hover',
      );
      if (!normal || !hover || normal.dom.launchDisabled || hover.dom.launchDisabled) {
        throw new Error(`${theme}: safe launch button was missing or disabled`);
      }
      if (normal.dom.launchBackground === hover.dom.launchBackground) {
        throw new Error(`${theme}: safe launch hover did not deepen the theme accent`);
      }
      if (hover.dom.launchOpacity !== '1') {
        throw new Error(`${theme}: safe launch hover became translucent`);
      }
    }

    const byFeature = Object.groupBy(captures, (capture) => capture.feature);
    for (const [feature, featureCaptures] of Object.entries(byFeature)) {
      writeFileSync(
        path.join(outputRoot, feature, 'manifest.json'),
        `${JSON.stringify({ captures: featureCaptures, generatedAt: new Date().toISOString(), isolated: true, themes }, null, 2)}\n`,
      );
    }
    writeFileSync(
      path.join(outputRoot, 'native-visual-manifest.json'),
      `${JSON.stringify({ captures, generatedAt: new Date().toISOString(), isolatedUserData, themes }, null, 2)}\n`,
    );
    console.log(`Native visual QA: ${captures.length} captures in ${outputRoot}`);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
