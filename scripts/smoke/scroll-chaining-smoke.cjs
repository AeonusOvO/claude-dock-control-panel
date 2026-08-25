/*
 * Exercises scroll chaining in real Electron/Chromium with trusted wheel input. Synthetic DOM wheel
 * events never run the browser default action and cannot reproduce compositor latching.
 *
 * `sendInputEvent` uses the Windows WM_MOUSEWHEEL sign: deltaY -120 is DOWN, the inverse of the DOM
 * WheelEvent convention observed by the renderer.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
app.setPath('userData', path.join(root, 'dist', '.electron-scroll-chaining-smoke'));

const setup = `
(() => {
  document.documentElement.dataset.scrollChainingMetrics = 'true';
  for (const page of document.querySelectorAll('[data-rail-page]')) {
    page.classList.remove('rail-page--active');
  }
  document.querySelector('[data-rail-page="connection"]').classList.add('rail-page--active');
  const choiceStep = document.querySelector('[data-connection-wizard-step="choice"]');
  const configureStep = document.querySelector('[data-connection-wizard-step="configure"]');
  choiceStep.hidden = true;
  choiceStep.classList.remove('connection-wizard-step--active', 'connection-wizard-step--leaving');
  configureStep.hidden = false;
  configureStep.classList.remove('connection-wizard-step--leaving');
  configureStep.classList.add('connection-wizard-step--active');
  configureStep.style.animation = 'none';
  delete document.querySelector('#connection-wizard-viewport').dataset.direction;
  configureStep.prepend(document.querySelector('#connection-history'));

  const list = document.querySelector('#connection-history-list');
  const empty = document.querySelector('#connection-history-empty');
  if (empty) empty.hidden = true;
  list.replaceChildren();

  for (let index = 0; index < 8; index += 1) {
    const item = document.createElement('li');
    item.className = 'connection-history__item';
    const restore = document.createElement('button');
    restore.className = 'connection-history__restore';
    restore.type = 'button';
    const titleRow = document.createElement('span');
    titleRow.className = 'connection-history__title-row';
    const title = document.createElement('strong');
    title.textContent = '历史配置 ' + index;
    titleRow.append(title);
    const parameters = document.createElement('span');
    parameters.className = 'connection-history__parameters';
    for (const label of ['接口 / 网关', '本地转换', '主模型', '小型/备用模型']) {
      const parameter = document.createElement('span');
      parameter.className = 'connection-history__parameter';
      const key = document.createElement('span');
      key.textContent = label;
      const value = document.createElement('code');
      value.textContent = 'https://example.invalid/very/long/endpoint/path/v1/messages';
      parameter.append(key, value);
      parameters.append(parameter);
    }
    const meta = document.createElement('span');
    meta.className = 'connection-history__meta';
    meta.textContent = '2026-08-20 · API Key · 含凭据 · 直连';
    restore.append(titleRow, parameters, meta);
    item.append(restore);
    list.append(item);
  }
  return true;
})()
`;

const measure = `
(() => {
  const room = (element) => Math.round(element.scrollHeight - element.clientHeight);
  const panel = document.querySelector('.control-panel');
  const list = document.querySelector('#connection-history-list');
  const restore = list.querySelector('.connection-history__restore');
  return {
    panel: { room: room(panel), top: Math.round(panel.scrollTop) },
    list: { room: room(list), top: Math.round(list.scrollTop) },
    restore: { room: room(restore), top: Math.round(restore.scrollTop) },
  };
})()
`;

const pointOver = (selector) => `
(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2))),
    y: Math.round(Math.max(8, Math.min(window.innerHeight - 8, rect.top + 12))),
  };
})()
`;

const armHandoff = (direction) => `
(() => {
  const panel = document.querySelector('.control-panel');
  const list = document.querySelector('#connection-history-list');
  const listRoom = list.scrollHeight - list.clientHeight;
  const panelRoom = panel.scrollHeight - panel.clientHeight;
  const edgeReserve = Math.min(24, Math.max(1, listRoom));
  if (${JSON.stringify(direction)} === 'down') {
    list.scrollTop = Math.max(0, listRoom - edgeReserve);
    panel.scrollTop = 0;
  } else {
    list.scrollTop = edgeReserve;
    panel.scrollTop = Math.min(200, panelRoom);
  }
  const rect = list.getBoundingClientRect();
  const before = { list: list.scrollTop, panel: panel.scrollTop };
  window.__scrollChainingHandoff = new Promise((resolve) => {
    window.addEventListener('wheel', (event) => {
      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * window.innerHeight
          : event.deltaY;
      requestAnimationFrame(() => resolve({
        after: { list: list.scrollTop, panel: panel.scrollTop },
        before,
        delta,
        listRoom,
      }));
    }, { once: true });
  });
  return {
    before,
    point: {
      x: Math.round(Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2))),
      y: Math.round(Math.max(8, Math.min(window.innerHeight - 8, rect.top + 12))),
    },
  };
})()
`;

const awaitHandoff = `window.__scrollChainingHandoff`;

const openTopLayerFixture = `
(async () => {
  const dialog = document.createElement('dialog');
  dialog.style.padding = '12px';
  const scroller = document.createElement('div');
  scroller.style.height = '120px';
  scroller.style.overflowY = 'auto';
  scroller.style.width = '260px';
  const content = document.createElement('div');
  content.style.height = '720px';
  content.textContent = '模态滚动边界';
  scroller.append(content);
  dialog.append(scroller);
  document.body.append(dialog);
  dialog.showModal();
  await new Promise(requestAnimationFrame);
  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
  const rect = scroller.getBoundingClientRect();
  const panel = document.querySelector('.control-panel');
  return {
    panelTop: panel.scrollTop,
    point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
    room: scroller.scrollHeight - scroller.clientHeight,
  };
})()
`;

const readTopLayerFixture = `
(() => {
  const dialog = document.querySelector('dialog[open]');
  const panel = document.querySelector('.control-panel');
  const scroller = dialog && dialog.querySelector('div');
  const result = { panelTop: panel.scrollTop, scrollerTop: scroller ? scroller.scrollTop : -1 };
  if (dialog) {
    dialog.close();
    dialog.remove();
  }
  return result;
})()
`;

const openTallSelect = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const select = document.querySelector('#terminal-theme');
  select.replaceChildren();
  for (let index = 0; index < 40; index += 1) {
    const option = document.createElement('option');
    option.value = 'value-' + index;
    option.textContent = '服务商选项 ' + index;
    select.append(option);
  }
  await sleep(120);

  const shell = select.closest('.select');
  const rect = shell.getBoundingClientRect();
  const init = {
    bubbles: true, button: 0, cancelable: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  };
  const hit = document.elementFromPoint(init.clientX, init.clientY);
  hit.dispatchEvent(new PointerEvent('pointerdown', init));
  hit.dispatchEvent(new MouseEvent('mousedown', init));
  await sleep(200);

  const listbox = [...document.querySelectorAll('.select__listbox')].find(
    (node) => node.dataset.open === 'true',
  );
  if (!listbox) return { opened: false };
  const box = listbox.getBoundingClientRect();
  return {
    opened: true,
    overscrollBehaviorY: getComputedStyle(listbox).overscrollBehaviorY,
    room: Math.round(listbox.scrollHeight - listbox.clientHeight),
    point: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
  };
})()
`;

const readListbox = `
(() => {
  const listbox = [...document.querySelectorAll('.select__listbox')].find(
    (node) => node.dataset.open === 'true',
  );
  const panel = document.querySelector('.control-panel');
  return {
    listboxTop: listbox ? Math.round(listbox.scrollTop) : -1,
    panelTop: Math.round(panel.scrollTop),
  };
})()
`;

const readMetrics = `
(() => ({
  handoffFrames: Number(document.documentElement.dataset.scrollChainingHandoffFrames || '0'),
  handlerP95: Number(document.documentElement.dataset.scrollChainingHandlerP95 || 'Infinity'),
}))()
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const installRendererStubs = () => {
  ipcMain.handle('busy:set-conversation', () => []);
  ipcMain.handle('busy:list', () => []);
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
    version: 'scroll-chaining-smoke',
  }));
  ipcMain.handle('ui:set-theme', () => undefined);
  ipcMain.handle('workspace:get-state', () => ({
    activeSessionId: '',
    projects: [],
    sessions: [],
  }));
  const unavailableTarget = {
    installed: false,
    message: 'scroll chaining smoke fixture',
    updateAvailable: false,
  };
  ipcMain.handle('software:updates-get', () => ({
    application: unavailableTarget,
    checkedAt: Date.now(),
    claudeCode: unavailableTarget,
    router: unavailableTarget,
  }));
  ipcMain.handle('software:application-updater-get', () => ({
    currentVersion: 'scroll-chaining-smoke',
    message: 'disabled in smoke',
    phase: 'disabled',
  }));
  ipcMain.handle('claude:plugins-marketplaces-refresh', () => 'disabled in smoke');
};

app
  .whenReady()
  .then(async () => {
    installRendererStubs();
    setTimeout(() => {
      console.error('\nscroll chaining smoke timed out');
      app.exit(1);
    }, 30_000);
    const window = new BrowserWindow({
      height: 760,
      // A hidden BrowserWindow silently drops trusted wheel notches; the test must remain visible.
      show: true,
      useContentSize: true,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(root, 'dist', 'preload', 'preload.js'),
      },
      width: 1180,
    });

    console.log('scroll smoke: loading renderer');
    await window.loadFile(path.join(root, 'dist', 'renderer', 'index.html'));
    console.log('scroll smoke: renderer loaded');
    await sleep(1_800);
    await window.webContents.executeJavaScript(setup, true);
    console.log('scroll smoke: fixture installed');
    await sleep(250);

    const failures = [];
    const start = await window.webContents.executeJavaScript(measure, true);
    console.log(JSON.stringify({ stage: 'geometry measured', start }, undefined, 2));
    window.show();
    window.focus();
    window.webContents.focus();
    await sleep(200);
    if (start.restore.room !== 0) {
      failures.push(
        `history cards should grow instead of owning an inner scrollbar (${start.restore.room})`,
      );
    }
    if (start.list.room <= 0) failures.push('the history list does not overflow');
    if (start.panel.room <= 0) failures.push('the control panel does not overflow');

    const sendWheel = async (point, direction, ticks = 1, gap = 45) => {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      for (let index = 0; index < ticks; index += 1) {
        window.webContents.sendInputEvent({
          canScroll: true,
          deltaX: 0,
          deltaY: direction === 'down' ? -120 : 120,
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
        });
        await sleep(gap);
      }
    };

    const assertHandoff = async (direction) => {
      const armed = await window.webContents.executeJavaScript(armHandoff(direction), true);
      console.log(JSON.stringify({ armed, direction }, undefined, 2));
      await sendWheel(armed.point, direction);
      const result = await window.webContents.executeJavaScript(awaitHandoff, true);
      const listMovement = result.after.list - result.before.list;
      const panelMovement = result.after.panel - result.before.panel;
      const totalMovement = listMovement + panelMovement;
      console.log(JSON.stringify({ direction, handoff: result }, undefined, 2));

      if (direction === 'down') {
        if (Math.abs(result.after.list - result.listRoom) > 1) {
          failures.push(
            `downward residual did not finish the child (${result.after.list}/${result.listRoom})`,
          );
        }
        if (panelMovement <= 0)
          failures.push('downward residual did not reach the parent in one frame');
      } else {
        if (Math.abs(result.after.list) > 1) {
          failures.push(`upward residual did not finish the child (${result.after.list}/0)`);
        }
        if (panelMovement >= 0)
          failures.push('upward residual did not reach the parent in one frame');
      }
      if (Math.abs(totalMovement - result.delta) > 2) {
        failures.push(
          `${direction} delta was not conserved (${totalMovement} moved for ${result.delta} input)`,
        );
      }
    };

    await assertHandoff('down');
    await assertHandoff('up');

    // A continuous burst must stay on the claimed history chain even as new cards slide under the
    // pointer; otherwise the list advances in lurches and the parent never receives the tail.
    await window.webContents.executeJavaScript(
      `
    (() => {
      const panel = document.querySelector('.control-panel');
      const list = document.querySelector('#connection-history-list');
      panel.scrollTop = 0;
      list.scrollTop = 0;
    })()
  `,
      true,
    );
    const listSpot = await window.webContents.executeJavaScript(
      pointOver('#connection-history-list'),
      true,
    );
    const continuousTicks = Math.max(8, Math.ceil((start.list.room + 240) / 120) + 2);
    await sendWheel(listSpot, 'down', continuousTicks, 60);
    await sleep(200);
    const afterContinuous = await window.webContents.executeJavaScript(measure, true);
    if (afterContinuous.list.top < afterContinuous.list.room - 2) {
      failures.push(
        `the continuous burst did not finish the history list (${afterContinuous.list.top}/${afterContinuous.list.room})`,
      );
    }
    if (afterContinuous.panel.top <= 0) {
      failures.push('the continuous burst did not continue from the history list to the panel');
    }

    // A modal top-layer root blocks the background even when its own scroller is already spent.
    const modal = await window.webContents.executeJavaScript(openTopLayerFixture, true);
    await sendWheel(modal.point, 'down', 3, 35);
    await sleep(100);
    const afterModal = await window.webContents.executeJavaScript(readTopLayerFixture, true);
    if (modal.room <= 0) failures.push('the modal fixture did not overflow');
    if (afterModal.panelTop !== modal.panelTop) {
      failures.push(
        `a modal wheel penetrated the shell (${modal.panelTop} -> ${afterModal.panelTop})`,
      );
    }

    // The enhanced select uses overscroll containment as a sealed non-dialog popup boundary.
    const listbox = await window.webContents.executeJavaScript(openTallSelect, true);
    if (!listbox.opened) {
      failures.push('the tall select popup did not open');
    } else if (listbox.room <= 0) {
      failures.push('the select popup did not become scrollable');
    } else {
      if (listbox.overscrollBehaviorY !== 'contain') {
        failures.push(`the select popup must seal chaining, saw ${listbox.overscrollBehaviorY}`);
      }
      const before = await window.webContents.executeJavaScript(readListbox, true);
      await sendWheel(listbox.point, 'down', 30, 30);
      await sleep(150);
      const after = await window.webContents.executeJavaScript(readListbox, true);
      console.log(JSON.stringify({ listbox, before, after }, undefined, 2));
      if (after.listboxTop <= before.listboxTop)
        failures.push('the select popup itself did not scroll');
      if (after.panelTop !== before.panelTop) {
        failures.push(
          `a spent select popup leaked to the shell (${before.panelTop} -> ${after.panelTop})`,
        );
      }
    }

    const metrics = await window.webContents.executeJavaScript(readMetrics, true);
    console.log(JSON.stringify({ metrics, start, afterContinuous }, undefined, 2));
    if (metrics.handoffFrames !== 1) {
      failures.push(`scroll handoff was not scheduled for one frame (${metrics.handoffFrames})`);
    }
    if (!Number.isFinite(metrics.handlerP95) || metrics.handlerP95 >= 2) {
      failures.push(`wheel handler p95 exceeded 2ms (${metrics.handlerP95}ms)`);
    }

    if (failures.length > 0) {
      console.error(`\nscroll chaining FAILED:\n- ${failures.join('\n- ')}`);
      app.exit(1);
      return;
    }
    console.log('\nscroll chaining OK');
    app.exit(0);
  })
  .catch((error) => {
    console.error('\nscroll chaining smoke crashed:', error);
    app.exit(1);
  });
