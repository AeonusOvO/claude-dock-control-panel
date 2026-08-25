const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

app.setPath('userData', path.join(__dirname, '..', '..', 'dist', '.electron-layout-smoke'));

const sizes = [
  [720, 640],
  [820, 640],
  [900, 640],
  [1024, 640],
  [1180, 760],
  [1280, 760],
];

const inspectLayout = `
(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none' ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
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
  const clippedRect = (element) => {
    const rect = element.getBoundingClientRect();
    const clipped = {
      bottom: Math.min(innerHeight, rect.bottom),
      left: Math.max(0, rect.left),
      right: Math.min(innerWidth, rect.right),
      top: Math.max(0, rect.top),
    };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (/auto|clip|hidden|scroll/.test(ancestorStyle.overflowX)) {
        clipped.left = Math.max(clipped.left, ancestorRect.left);
        clipped.right = Math.min(clipped.right, ancestorRect.right);
      }
      if (/auto|clip|hidden|scroll/.test(ancestorStyle.overflowY)) {
        clipped.top = Math.max(clipped.top, ancestorRect.top);
        clipped.bottom = Math.min(clipped.bottom, ancestorRect.bottom);
      }
    }
    return clipped;
  };
  const openDialog = document.querySelector('dialog[open]');
  const openArtifactDetails = document.querySelector(".artifact-details[data-open='true']");
  const inspectionRoot = openDialog || openArtifactDetails || document;
  const selector =
    'button, input, select, textarea, a[href], iframe, [role="separator"], [tabindex]:not([tabindex="-1"])';
  const controls = [...inspectionRoot.querySelectorAll(selector)].filter(
    (element) => visible(element) && !element.classList.contains('workbench-scrim'),
  );
  /*
   * An enhanced select deliberately has two coincident interactive layers: the transparent native
   * select owns focus, accessibility and pointer input, while the aria-hidden button paints the
   * control. They are one composite control, not two controls obscuring each other. Keep this
   * exception scoped to the same shell so overlaps between separate selects still fail the smoke.
   */
  const compositeControl = (element) => element.closest('.select');
  const shareCompositeControl = (left, right) => {
    const owner = compositeControl(left);
    return Boolean(owner && owner === compositeControl(right));
  };
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
      return !hit || (!element.contains(hit) && !shareCompositeControl(element, hit));
    })
    .map((element) => element.id || element.textContent.trim().slice(0, 24));
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
    const left = controls[leftIndex];
    // Scroll containers may expose only part of a control; compare painted bounds so clipped content
    // does not look like it sits on top of the fixed composer below it.
    const leftRect = clippedRect(left);
    for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
      const right = controls[rightIndex];
      if (left.contains(right) || right.contains(left)) continue;
      if (shareCompositeControl(left, right)) continue;
      const rightRect = clippedRect(right);
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
  // chat-shell intentionally clips the translated, closed artifact drawer, so its scrollWidth
  // includes off-canvas geometry. Inspect every user-facing child instead of treating that
  // deliberate clipping container as content overflow.
  const overflow = [...inspectionRoot.querySelectorAll(
    '.control-panel, .rail-page--active, .terminal-toolbar, .terminal-footer, .chat-toolbar, .chat-toolbar__metrics, .chat-metric, .chat-messages, .chat-message, .chat-message__content, .chat-message__attachments, .chat-attachment-card, .chat-composer, .chat-history, .chat-history__item, .chat-history__open, .artifact-view, .artifact-details, .artifact-details__body, .artifact-active-list__item, .artifact-network-log__item, .plugin-toolbar, .plugin-tabs, .plugin-panel--active, .plugin-list, .plugin-card, .plugin-card__header, .plugin-card__actions, #plugin-marketplace-form, .install-source-row, .router-actions, .claude-workbench, .current-connection, .connection-history-recovery, .connection-history-recovery__details, .connection-wizard-progress, .connection-wizard-viewport, .connection-wizard-step--active, .provider-picker, .provider-groups, .access-choice-grid, .access-choice-card, .domestic-model-picker, .connection-wizard-actions, .connection-advanced-dialog__shell, .connection-history-dialog__shell, .connection-history-dialog__panel, .connection-history-dialog__list, .settings-layout, .settings-panel--active, #connection-advanced-content, .connection-history, .connection-history__item, .connection-history__restore'
  )]
    .filter(visible)
    .filter((element) => element.scrollWidth > element.clientWidth + 2)
    .map((element) => element.id || element.className);

  const horizontalClips = [...inspectionRoot.querySelectorAll(
    '.current-connection, .connection-history-recovery, .connection-wizard-progress, .provider-picker, .access-choice-card, .connection-wizard-actions, .connection-history-dialog__shell, .connection-history-dialog__panel, .connection-history-dialog__footer'
  )]
    .filter(visible)
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const painted = clippedRect(element);
      return painted.left - rect.left > 1 || rect.right - painted.right > 1;
    })
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

  const mask = document.querySelector('.terminal-mask');
  const stage = document.querySelector('#terminal-stage');
  const maskNeutral =
    !mask ||
    !stage ||
    (() => {
      const maskRect = mask.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      return (
        Math.abs(maskRect.left - stageRect.left) <= 1 &&
        Math.abs(maskRect.top - stageRect.top) <= 1 &&
        Math.abs(maskRect.width - stageRect.width) <= 1 &&
        Math.abs(maskRect.height - stageRect.height) <= 1
      );
    })();

  return {
    covered,
    documentOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    hitTargetMisses,
    horizontalClips,
    maskNeutral,
    overlaps,
    overflow,
  };
})()
`;

const addDetectorCalibrationFixture = `
(() => {
  const fixture = document.createElement('div');
  fixture.id = 'layout-detector-calibration';
  for (const id of ['layout-detector-calibration-back', 'layout-detector-calibration-front']) {
    const button = document.createElement('button');
    button.id = id;
    button.style.cssText =
      'position: fixed; left: 8px; top: 8px; width: 40px; height: 40px; z-index: 2147483646;';
    fixture.append(button);
  }
  document.body.append(fixture);
})()
`;

const selectRailPage = (name) => `
  (() => {
  const workspace = document.querySelector('.workspace');
  workspace.style.transition = 'none';
  workspace.classList.remove(
    'workspace--rail-collapsed',
    'workspace--rail-preview',
  );
  workspace.dataset.railPanel =
    ['plugins', 'mcp'].includes(${JSON.stringify(name)}) ? 'extensions' : ${JSON.stringify(name)};
  void workspace.offsetWidth;
  workspace.style.removeProperty('transition');
  document.querySelector('.control-panel').inert = false;
  document.querySelector('.control-panel').setAttribute('aria-hidden', 'false');
  for (const page of document.querySelectorAll('[data-rail-page]')) {
    page.classList.toggle('rail-page--active', page.dataset.railPage === ${JSON.stringify(name)});
  }
  document.querySelector('#terminal-shell').hidden = ${JSON.stringify(name)} === 'chat';
  document.querySelector('#chat-shell').hidden = ${JSON.stringify(name)} !== 'chat';
  })();
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

const addConnectionHistoryStressFixture = `
  (() => {
    const list = document.querySelector('#connection-history-list');
    list.replaceChildren();
    const item = document.createElement('li');
    item.className = 'connection-history__item';
    const restore = document.createElement('button');
    restore.className = 'connection-history__restore';
    restore.type = 'button';
    const title = document.createElement('strong');
    title.textContent = '本机转换器 / 模型网关';
    const parameters = document.createElement('span');
    parameters.className = 'connection-history__parameters';
    for (const [labelText, valueText] of [
      ['接口 / 网关', 'https://gateway.example.com/an/intentionally/long/anthropic/v1/messages'],
      ['主模型', 'provider/a-very-long-primary-model-name-that-must-wrap'],
      ['快速模型', 'provider/a-very-long-fast-model-name-that-must-wrap'],
    ]) {
      const parameter = document.createElement('span');
      parameter.className = 'connection-history__parameter';
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('code');
      value.textContent = valueText;
      parameter.append(label, value);
      parameters.append(parameter);
    }
    const meta = document.createElement('span');
    meta.className = 'connection-history__meta';
    meta.textContent = '07/27 23:58 · Bearer · 含凭据 · 网关运行中';
    restore.append(title, parameters, meta);
    const remove = document.createElement('button');
    remove.className = 'connection-history__delete';
    remove.type = 'button';
    remove.textContent = '×';
    item.append(restore, remove);
    list.append(item);
    document.querySelector('#connection-history-empty').hidden = true;
    document.querySelector('#connection-history-count').textContent =
      '1 条历史配置 · 点击恢复全部参数';

    const dialogList = document.querySelector('[data-history-dialog-list="api"]');
    dialogList.replaceChildren(...Array.from({ length: 4 }, () => item.cloneNode(true)));
    dialogList.hidden = false;
    document.querySelector('[data-history-dialog-empty="api"]').hidden = true;
    document.querySelector('[data-history-dialog-count="api"]').textContent = '4 条';
    document.querySelector('#connection-history-dialog-summary').textContent =
      '当前项目共 4 条接入记录';
  })()
`;

const showConnectionHistoryRecoveryFixture = `
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
      surface.dataset.layoutWasHidden = String(surface.hidden);
      surface.dataset.layoutWasInert = String(surface.hasAttribute('inert'));
      surface.hidden = true;
      surface.toggleAttribute('inert', true);
    }
    const recovery = document.querySelector('#connection-history-recovery');
    recovery.hidden = false;
    recovery.removeAttribute('inert');
    recovery.dataset.phase = 'failure';
    document.querySelector('#connection-history-recovery-kicker').textContent = '接入未完成';
    document.querySelector('#connection-history-recovery-title').textContent =
      '一个名称和接口地址都很长的团队 API 中转站接入失败';
    document.querySelector('#connection-history-recovery-detail').textContent =
      '历史配置未通过连接测试，请检查网络、认证方式与模型标识后重新接入。';
    const details = document.querySelector('#connection-history-recovery-details');
    details.replaceChildren();
    for (const [label, status, detail] of [
      ['接口地址', '失败', 'https://gateway.example.com/an/intentionally/long/anthropic/v1/messages'],
      ['身份认证', '未执行', '接口连通后才能确认凭据。'],
      ['模型响应', '未执行', '认证通过后才能验证超长模型标识。'],
    ]) {
      const item = document.createElement('li');
      item.dataset.status = status === '失败' ? 'failed' : 'skipped';
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
  })()
`;

const hideConnectionHistoryRecoveryFixture = `
  (() => {
    document.querySelector('#connection-history-recovery').hidden = true;
    for (const surface of document.querySelectorAll('[data-layout-was-hidden]')) {
      surface.hidden = surface.dataset.layoutWasHidden === 'true';
      surface.toggleAttribute('inert', surface.dataset.layoutWasInert === 'true');
      delete surface.dataset.layoutWasHidden;
      delete surface.dataset.layoutWasInert;
    }
  })()
`;

const addChatStressFixture = `
  (() => {
    document.querySelector('#chat-active-model').textContent =
      'provider/a-very-long-model-name-for-responsive-layout';
    document.querySelector('#chat-context-total').textContent = '128.6K tokens';
    document.querySelector('#chat-token-usage').textContent = '输入 126.8K · 输出 1.8K';
    const list = document.querySelector('#chat-history-list');
    list.replaceChildren();
    for (const [titleText, metaText] of [
      [
        '一条需要在最窄控制栏内正确截断而不能撑破布局的对话标题',
        '7月28日 21:42 · 100 条消息 · 128.6K tokens',
      ],
      ['第二条对话', '7月28日 20:16 · 6 条消息 · 2.8K tokens'],
    ]) {
      const item = document.createElement('div');
      item.className = 'chat-history__item';
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
      list.append(item);
    }
    document.querySelector('#chat-history-empty').hidden = true;
    document.querySelector('#chat-history-count').textContent = '2 条';
  })()
`;

const addRichChatStressFixture = `
  (() => {
    const messages = document.querySelector('#chat-messages');
    messages.replaceChildren();

    const user = document.createElement('article');
    user.className = 'chat-message chat-message--user';
    const userLabel = document.createElement('strong');
    userLabel.textContent = '你';
    const userBody = document.createElement('div');
    userBody.className = 'chat-message__content';
    userBody.textContent = '请同时解释架构、比较方案，并给出可以复制运行的示例。';
    user.append(userLabel, userBody);

    const assistant = document.createElement('article');
    assistant.className = 'chat-message chat-message--assistant';
    const assistantLabel = document.createElement('strong');
    assistantLabel.textContent = '模型';
    const body = document.createElement('div');
    body.className = 'chat-message__content chat-message__markdown';
    const heading = document.createElement('h1');
    heading.textContent = '富文本与附件布局验收';
    const intro = document.createElement('p');
    intro.append('这段内容同时覆盖 ', document.createElement('strong'), '、链接、列表和长表格。');
    intro.querySelector('strong').textContent = 'Markdown';
    const remoteImage = document.createElement('span');
    remoteImage.className = 'markdown-remote-image';
    remoteImage.setAttribute('role', 'group');
    const remoteImageLabel = document.createElement('span');
    remoteImageLabel.className = 'markdown-remote-image__label';
    remoteImageLabel.textContent =
      'architecture-diagram-with-a-long-private-query.png（为保护隐私，未自动加载）';
    const remoteImageOpen = document.createElement('button');
    remoteImageOpen.className = 'button button--quiet markdown-remote-image__open';
    remoteImageOpen.type = 'button';
    remoteImageOpen.textContent = '在外部浏览器打开图片';
    remoteImage.append(remoteImageLabel, remoteImageOpen);
    const quote = document.createElement('blockquote');
    quote.textContent = '任何宽度下都不能遮挡工具栏、输入区或右侧审计抽屉。';
    const list = document.createElement('ul');
    for (const text of ['安全 DOM 白名单', '稳定前缀流式渲染', 'HTML Artifact 显式运行']) {
      const item = document.createElement('li');
      item.textContent = text;
      list.append(item);
    }
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['能力', '安全边界', '特别长的验证说明列']) {
      const cell = document.createElement('th');
      cell.textContent = text;
      headRow.append(cell);
    }
    head.append(headRow);
    const tableBody = document.createElement('tbody');
    const row = document.createElement('tr');
    for (const text of [
      'Markdown / KaTeX / Shiki',
      '不执行原始 HTML；危险 URL 降级为文本',
      'provider/a-very-long-model-and-artifact-description-that-must-scroll-inside-the-table',
    ]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    tableBody.append(row);
    table.append(head, tableBody);
    const code = document.createElement('pre');
    code.className = 'markdown-code';
    code.dataset.language = 'typescript';
    const copy = document.createElement('button');
    copy.className = 'markdown-code__copy';
    copy.type = 'button';
    copy.textContent = '复制';
    const codeBody = document.createElement('code');
    codeBody.textContent =
      "const result = await renderArtifactWithAnIntentionallyLongFunctionName({ network: false });";
    code.append(copy, codeBody);
    const run = document.createElement('button');
    run.className = 'markdown-artifact-run';
    run.type = 'button';
    run.textContent = '运行此可视化';
    const artifact = document.createElement('div');
    artifact.className = 'artifact-view';
    artifact.dataset.state = 'idle';
    const attachments = document.createElement('div');
    attachments.className = 'chat-message__attachments';
    for (const [kind, name, meta] of [
      ['image', 'terminal-theme-preview.png', 'image/png · 2.4 MB'],
      ['document', 'architecture-review.pdf', 'application/pdf · 8.7 MB'],
      ['document', 'benchmark-results.csv', 'text/csv · 128 KB'],
    ]) {
      const card = document.createElement('div');
      card.className = 'chat-attachment-card chat-attachment-card--' + kind;
      const preview = document.createElement('span');
      preview.className = 'chat-attachment-card__preview';
      preview.textContent = kind === 'image' ? 'IMG' : name.endsWith('.pdf') ? 'PDF' : 'CSV';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = name;
      const detail = document.createElement('small');
      detail.textContent = meta;
      copy.append(title, detail);
      card.append(preview, copy);
      attachments.append(card);
    }
    body.append(
      attachments,
      heading,
      intro,
      remoteImage,
      quote,
      list,
      table,
      code,
      run,
      artifact,
    );
    assistant.append(assistantLabel, body);
    messages.append(user, assistant);
    messages.scrollTop = 0;
  })()
`;

const addTerminalMaskFixture = `
  (() => {
    document.querySelector('.terminal-mask')?.remove();
    const stage = document.querySelector('#terminal-stage');
    const empty = document.querySelector('#terminal-empty-state');
    empty.style.display = 'none';
    const mask = document.createElement('div');
    mask.className = 'terminal-mask';
    mask.dataset.staticFixture = 'layout-only';
    const snapshot = document.createElement('div');
    snapshot.className = 'terminal-mask__snapshot';
    const fallback = document.createElement('pre');
    fallback.className = 'terminal-mask__fallback';
    fallback.textContent =
      'PS D:\\\\Projects\\\\ClaudeDock> claude\\n正在处理不会改变终端网格的静态布局 fixture…';
    snapshot.append(fallback);
    const veil = document.createElement('div');
    veil.className = 'terminal-mask__veil';
    const label = document.createElement('span');
    label.className = 'terminal-mask__label';
    label.textContent = '正在执行操作';
    veil.append(label);
    mask.append(snapshot, veil);
    stage.append(mask);
  })()
`;

const addArtifactDetailsStressFixture = `
  (() => {
    const active = document.querySelector('#artifact-active-list');
    active.replaceChildren();
    const activeRow = document.createElement('div');
    activeRow.className = 'artifact-active-list__item';
    const activeId = document.createElement('code');
    activeId.textContent = 'artifact-00000000-0000-4000-8000-000000000001';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '停止运行';
    activeRow.append(activeId, stop);
    active.append(activeRow);

    const log = document.querySelector('#artifact-network-log');
    log.replaceChildren();
    for (const [method, url, result] of [
      ['GET', 'https://api.example.com/a/very/long/path/to/visualization/data.json?range=all', '200 · 48 KB'],
      ['POST', 'https://telemetry.example.com/blocked/by-the-user-network-toggle', '已拦截'],
    ]) {
      const item = document.createElement('li');
      item.className = 'artifact-network-log__item';
      const title = document.createElement('strong');
      title.textContent = method + ' · ' + result;
      const address = document.createElement('code');
      address.textContent = url;
      item.append(title, address);
      log.append(item);
    }
  })()
`;

const installLayoutSmokeStubs = () => {
  const emptyWorkspace = { activeSessionId: '', projects: [], sessions: [] };
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
    version: 'layout-smoke',
  }));
  ipcMain.handle('ui:set-theme', () => undefined);
  ipcMain.handle('workspace:get-state', () => emptyWorkspace);
};

const runDetectorCalibration = async (window) => {
  await window.webContents.executeJavaScript(addConnectionHistoryStressFixture);
  await window.webContents.executeJavaScript(addChatStressFixture);
  await window.webContents.executeJavaScript(addRichChatStressFixture);
  await window.webContents.executeJavaScript(addArtifactDetailsStressFixture);
  await window.webContents.executeJavaScript(addDetectorCalibrationFixture);
  const detectorCalibration = await window.webContents.executeJavaScript(inspectLayout);
  await window.webContents.executeJavaScript(
    `document.querySelector('#layout-detector-calibration')?.remove()`,
  );
  const detectorCalibrationPassed =
    detectorCalibration.hitTargetMisses.includes('layout-detector-calibration-back') &&
    detectorCalibration.overlaps.some(
      ([left, right]) =>
        left === 'layout-detector-calibration-back' &&
        right === 'layout-detector-calibration-front',
    );
  return detectorCalibrationPassed;
};

const collectScenarios = async (window) => {
  const results = [];
  for (const [width, height] of sizes) {
    window.setSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // setSize on a hidden window can defer the renderer viewport long past the wait above, so the
    // settle below would freeze stale geometry. The 720 -> 820 boundary is the one crossing whose
    // transition start frame collapses the rail column to 0px (max-width: 720px); if the resize
    // lands mid-loop instead, that grid transition never animates in a hidden window and every
    // remaining scenario in the loop fails on collapsed-rail geometry. Poll until the viewport
    // actually reaches the new width (scrollbar slack included) before settling.
    await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const target = ${JSON.stringify(width)};
        const startedAt = performance.now();
        const poll = () => {
          if (Math.abs(window.innerWidth - target) <= 24 || performance.now() - startedAt > 3000) {
            resolve(window.innerWidth);
          } else {
            setTimeout(poll, 40);
          }
        };
        poll();
      })
    `);
    await window.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('.workspace');
        // Hidden CI windows can throttle a responsive grid transition indefinitely. Settle the
        // target geometry synchronously before inspecting the 720/1024/1280 boundary cases.
        workspace.style.transition = 'none';
        void workspace.offsetWidth;
        workspace.style.removeProperty('transition');
      })()
    `);
    for (const page of ['projects', 'connection', 'chat']) {
      await window.webContents.executeJavaScript(selectRailPage(page));
      const result = await window.webContents.executeJavaScript(inspectLayout);
      results.push({ height, page, width, ...result });
      if (page === 'connection') {
        await window.webContents.executeJavaScript(`
          document.querySelector('.connection-wizard-actions').scrollIntoView({ block: 'end' });
        `);
        await new Promise((resolve) => setTimeout(resolve, 80));
        results.push({
          height,
          page: 'connection:actions',
          width,
          ...(await window.webContents.executeJavaScript(inspectLayout)),
        });
        await window.webContents.executeJavaScript(`
          document.querySelector('.control-panel').scrollTop = 0;
        `);
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
          })();
        `);
        await new Promise((resolve) => setTimeout(resolve, 420));
        results.push({
          height,
          page: 'connection:history-dialog',
          width,
          ...(await window.webContents.executeJavaScript(inspectLayout)),
        });
        await window.webContents.executeJavaScript(`
          document.querySelector('#connection-history-dialog').close();
        `);
        await window.webContents.executeJavaScript(showConnectionHistoryRecoveryFixture);
        results.push({
          height,
          page: 'connection:history-recovery',
          width,
          ...(await window.webContents.executeJavaScript(inspectLayout)),
        });
        await window.webContents.executeJavaScript(hideConnectionHistoryRecoveryFixture);
      }
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
    await window.webContents.executeJavaScript(selectRailPage('projects'));
    await window.webContents.executeJavaScript(addTerminalMaskFixture);
    await new Promise((resolve) => setTimeout(resolve, 80));
    results.push({
      height,
      page: 'terminal:mask-static-fixture',
      width,
      ...(await window.webContents.executeJavaScript(inspectLayout)),
    });
    await window.webContents.executeJavaScript(`
      document.querySelector('.terminal-mask')?.remove();
      document.querySelector('#terminal-empty-state').style.display = '';
    `);
    await window.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('.workspace');
        // Hidden CI windows can throttle CSS transitions indefinitely. This scenario verifies the
        // collapsed end-state geometry, so settle it synchronously without changing app CSS.
        workspace.style.transition = 'none';
        workspace.classList.add('workspace--rail-collapsed');
        void workspace.offsetWidth;
      })()
    `);
    results.push({
      height,
      page: 'rail:collapsed',
      width,
      ...(await window.webContents.executeJavaScript(inspectLayout)),
    });
    await window.webContents.executeJavaScript(`
      (() => {
        const workspace = document.querySelector('.workspace');
        workspace.classList.remove('workspace--rail-collapsed');
        void workspace.offsetWidth;
        workspace.style.removeProperty('transition');
        document.querySelector('#connection-advanced-dialog').showModal();
      })()
    `);
    for (const settingsPage of ['general', 'connection']) {
      await window.webContents.executeJavaScript(`
        for (const tab of document.querySelectorAll('[data-settings-tab]')) {
          const active = tab.dataset.settingsTab === ${JSON.stringify(settingsPage)};
          tab.classList.toggle('settings-tab--active', active);
          tab.setAttribute('aria-selected', String(active));
        }
        for (const panel of document.querySelectorAll('[data-settings-panel]')) {
          panel.classList.toggle(
            'settings-panel--active',
            panel.dataset.settingsPanel === ${JSON.stringify(settingsPage)},
          );
        }
      `);
      await new Promise((resolve) => setTimeout(resolve, 80));
      results.push({
        height,
        page: `settings:${settingsPage}`,
        width,
        ...(await window.webContents.executeJavaScript(inspectLayout)),
      });
    }
    await window.webContents.executeJavaScript(`
      document.querySelector('#connection-advanced-dialog').close();
    `);
    await window.webContents.executeJavaScript(selectRailPage('chat'));
    await window.webContents.executeJavaScript(`
      (() => {
        const artifactDetailsPanel = document.querySelector('#artifact-details-panel');
        artifactDetailsPanel.dataset.open = 'true';
        artifactDetailsPanel.setAttribute('aria-hidden', 'false');
        artifactDetailsPanel.inert = false;
        artifactDetailsPanel.removeAttribute('inert');
        document.querySelector('#artifact-details-scrim').hidden = false;
        document.querySelector('#chat-artifact-details').setAttribute('aria-expanded', 'true');
      })()
    `);
    // Drawer entrance tokens run as long as 340 ms (Telegram); inspect only after
    // the geometry and pointer target have reached their final positions.
    await new Promise((resolve) => setTimeout(resolve, 420));
    results.push({
      height,
      page: 'chat:artifact-details',
      width,
      ...(await window.webContents.executeJavaScript(inspectLayout)),
    });
    await window.webContents.executeJavaScript(`
      (() => {
        const artifactDetailsPanel = document.querySelector('#artifact-details-panel');
        artifactDetailsPanel.dataset.open = 'false';
        artifactDetailsPanel.setAttribute('aria-hidden', 'true');
        artifactDetailsPanel.inert = true;
        artifactDetailsPanel.setAttribute('inert', '');
        document.querySelector('#artifact-details-scrim').hidden = true;
        document.querySelector('#chat-artifact-details').setAttribute('aria-expanded', 'false');
      })()
    `);
  }
  return results;
};

app.whenReady().then(async () => {
  installLayoutSmokeStubs();
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
  await window.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  const detectorCalibrationPassed = await runDetectorCalibration(window);
  const results = await collectScenarios(window);
  const expectedScenarios = sizes.length * 17;
  const failures = results.filter(
    (result) =>
      result.documentOverflow ||
      result.hitTargetMisses.length > 0 ||
      result.horizontalClips.length > 0 ||
      !result.maskNeutral ||
      result.overlaps.length > 0 ||
      result.overflow.length > 0 ||
      result.covered.length > 0,
  );
  console.log(
    JSON.stringify(
      {
        detectorCalibrationPassed,
        expectedScenarios,
        failures,
        scenarios: results.length,
        staticFixtureNotice:
          'terminal:mask-static-fixture only verifies layout geometry; it is not a ConPTY resize test.',
      },
      null,
      2,
    ),
  );
  app.exit(
    detectorCalibrationPassed && failures.length === 0 && results.length === expectedScenarios
      ? 0
      : 1,
  );
});
