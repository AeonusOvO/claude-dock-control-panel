/* eslint-disable max-lines-per-function -- 单进程线性 QA 流程：CDP 工具闭包链共享 client 与 captures 状态，拆分会破坏真实窗口场景的时序可读性。 */
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const outputRoot = path.join(root, 'dist', 'visual-qa', 'real-electron');
const isolatedRoot = path.join(
  root,
  'dist',
  '.electron-real-visual-qa',
  `run-${Date.now().toString(36)}`,
);
const userData = path.join(isolatedRoot, 'userData');
const appPreferences = path.join(userData, 'app-preferences');
const fakeHome = path.join(isolatedRoot, 'home');
const projects = path.join(isolatedRoot, 'projects');
const projectPath = path.join(projects, 'native-conversation-visual-project');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

for (const directory of [outputRoot, userData, appPreferences, fakeHome, projects, projectPath]) {
  mkdirSync(directory, { recursive: true });
}
writeFileSync(
  path.join(appPreferences, 'onboarding.json'),
  `${JSON.stringify(
    {
      completedSteps: [],
      currentStep: 'engine',
      flowVersion: 2,
      status: 'pending',
      version: 2,
    },
    null,
    2,
  )}\n`,
);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const reservePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a DevTools port.'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

class CdpClient {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

const waitForTarget = async (port) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
        if (!response.ok) throw new Error(`DevTools returned ${response.status}.`);
        return response.json();
      });
      const page = targets.find(
        (target) => target.type === 'page' && target.title.includes('ClaudeDock'),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The real Electron window may not have exposed its renderer yet.
    }
    await delay(150);
  }
  throw new Error('Timed out waiting for the real ClaudeDock Electron window.');
};

/**
 * Every `waitFor` predicate is written as `() => ...`, so the trailing `()` is what actually runs it.
 * Without the call the renderer just evaluates a function object, which is truthy, and every wait
 * returns on its first poll — the harness then photographs and asserts against whatever state
 * happened to be on screen. That failure mode is silent in the passing direction, so `waitFor`
 * additionally refuses any result that is still a function.
 */
const expression = (source) => `(${source})()`;

const main = async () => {
  const port = await reservePort();
  const child = spawn(
    electronPath,
    [
      '.',
      '--claudedock-runtime-profile=isolated',
      `--claudedock-user-data=${userData}`,
      `--claudedock-home=${fakeHome}`,
      `--claudedock-projects=${projects}`,
      '--claudedock-conversation-adapter=fake',
      `--remote-debugging-port=${port}`,
    ],
    {
      cwd: root,
      detached: false,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  let client;
  const captures = [];
  try {
    const target = await waitForTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.call('Page.enable');
    await client.call('Runtime.enable');

    const evaluate = async (source, awaitPromise = true) => {
      const result = await client.call('Runtime.evaluate', {
        awaitPromise,
        expression: source,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? 'Renderer evaluation failed.',
        );
      }
      if (result.result?.type === 'function') {
        // Nothing in this harness legitimately evaluates to a function. Getting one back means a
        // predicate was stringified but never called, which reads as "condition met" at every call
        // site and turns the whole suite into a screenshotter with no waits.
        throw new Error(`Renderer evaluation returned a function instead of a value: ${source}`);
      }
      return result.result?.value;
    };

    const waitFor = async (source, label, timeout = 15_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression(source))) return;
        await delay(100);
      }
      // An open modal blocks nearly every transition this harness waits on, and reporting only the
      // label sends the reader looking for the wrong bug. Name the dialog when one is up.
      const diagnostics = await evaluate(`(() => {
        const dialog = [...document.querySelectorAll('dialog')].find((node) => node.open);
        const send = document.querySelector('#native-send');
        const queued = document.querySelector('#native-queued');
        const input = document.querySelector('#native-composer-input');
        return {
          blocker: dialog
            ? (dialog.id || dialog.className || 'dialog') + ': ' +
              (dialog.querySelector('h1, h2, h3, .dialog__title')?.textContent ?? '').trim()
            : '',
          inputDisabled: input?.disabled ?? '(missing)',
          inputLength: input?.value.length ?? -1,
          nativeState: document.querySelector('#native-conversation')?.dataset.state ?? '(missing)',
          queuedHidden: queued?.hidden ?? '(missing)',
          queuedState: queued?.dataset.state ?? '(missing)',
          sendAction: send?.dataset.action ?? '(missing)',
          sendDisabled: send?.disabled ?? '(missing)',
          sendSending: send?.dataset.sending ?? '(unset)',
          status: document.querySelector('#native-composer-status')?.textContent ?? '(missing)',
          toast: document.querySelector('#toast')?.textContent ?? '(missing)',
          activeRuntime: document.body.dataset.agentRuntime ?? '(missing)',
          codexChecked: document.querySelector('#runtime-codex')?.checked ?? '(missing)',
          runtimePickerDisabled: document.querySelector('#runtime-picker')?.disabled ?? '(missing)',
          toggleBusy: document.querySelector('#native-terminal-toggle')?.getAttribute('aria-busy') ?? '(missing)',
          toggleDisabled: document.querySelector('#native-terminal-toggle')?.disabled ?? '(missing)',
        };
      })()`);
      const diagnosticText = JSON.stringify(diagnostics);
      throw new Error(
        diagnostics.blocker
          ? `Timed out waiting for ${label} — an open dialog is blocking it (${diagnostics.blocker}); renderer state: ${diagnosticText}.`
          : `Timed out waiting for ${label}; renderer state: ${diagnosticText}.`,
      );
    };

    const elementCenter = async (selector) => {
      const scrolled = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      })()`);
      if (!scrolled) throw new Error(`Missing real-window element: ${selector}`);
      await delay(80);
      const value = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          height: rect.height,
          hit: hit?.id || hit?.className || hit?.tagName || '(none)',
          hittable: Boolean(hit && (hit === element || element.contains(hit))),
          width: rect.width,
          x,
          y,
        };
      })()`);
      if (!value) throw new Error(`Missing real-window element: ${selector}`);
      if (value.width <= 0 || value.height <= 0 || !value.hittable) {
        throw new Error(
          `Real-window element is not physically hittable: ${selector} (${value.width}x${value.height}; hit ${value.hit}).`,
        );
      }
      return value;
    };

    const click = async (selector, holdMilliseconds = 45) => {
      const point = await elementCenter(selector);
      await client.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
      });
      await client.call('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type: 'mousePressed',
        x: point.x,
        y: point.y,
      });
      await delay(holdMilliseconds);
      await client.call('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
      });
    };

    /**
     * Moves the cursor off whatever was last clicked. The stop state is defined by having *no*
     * background, and `.native-composer__send[data-action='stop']:not(:disabled):hover` paints one,
     * so a resting screenshot taken with the pointer still parked on the button would be a lie.
     */
    const parkPointer = async () => {
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
      await delay(40);
    };

    const capture = async (file, metadata, settleMilliseconds = 80) => {
      if (settleMilliseconds > 0) await delay(settleMilliseconds);
      const result = await client.call('Page.captureScreenshot', {
        captureBeyondViewport: false,
        format: 'png',
        fromSurface: true,
      });
      const bytes = Buffer.from(result.data, 'base64');
      if (bytes.length < 1_000) throw new Error(`Invalid real Electron capture: ${file}`);
      writeFileSync(path.join(outputRoot, file), bytes);
      const dom = await evaluate(`(() => ({
        footerDisplay: getComputedStyle(document.querySelector('.terminal-footer')).display,
        footerEffort: document.querySelector('#footer-effort')?.textContent ?? '',
        footerMode: document.querySelector('#footer-mode')?.textContent ?? '',
        footerModel: document.querySelector('#footer-model')?.textContent ?? '',
        footerSpeed: document.querySelector('#footer-speed')?.textContent ?? '',
        footerSpeedState: document.querySelector('#footer-speed')?.dataset.state ?? '',
        queuedHidden: document.querySelector('#native-queued')?.hidden ?? true,
        queuedState: document.querySelector('#native-queued')?.dataset.state ?? '',
        sendAction: document.querySelector('#native-send')?.dataset.action ?? '',
        sendStopping: document.querySelector('#native-send')?.dataset.stopping ?? '',
        launchButtonDisabled: document.querySelector('#run-claude')?.disabled ?? true,
        launchButtonOpacity: getComputedStyle(document.querySelector('#run-claude')).opacity,
        launchButtonText: document.querySelector('#run-agent-label')?.textContent ?? '',
        nativeState: document.querySelector('#native-conversation')?.dataset.state ?? '',
        redundantModelStatus: Boolean(document.querySelector('#native-model-status')),
        summaryAnimation: getComputedStyle(document.querySelector('#runtime-activity-panel')).animationName,
        summaryBackground: getComputedStyle(document.querySelector('#runtime-activity-panel')).backgroundColor,
        summaryOpacity: getComputedStyle(document.querySelector('#runtime-activity-panel')).opacity,
        summaryState: document.querySelector('#runtime-activity-panel')?.dataset.state ?? '',
        openDialogs: [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.id),
        workbenchScrim: document.querySelector('#workbench-scrim')?.className ?? '',
        diagnosticScrimHidden: document.querySelector('#terminal-diagnostic-scrim')?.hidden ?? true,
        summaryPointStack: document.elementsFromPoint(window.innerWidth - 220, 220).slice(0, 6).map((element) => element.id || element.className || element.tagName),
        terminalToggleClass: document.querySelector('#native-terminal-toggle')?.className ?? '',
        theme: document.documentElement.dataset.theme ?? '',
        title: document.querySelector('#terminal-project')?.textContent ?? '',
      }))()`);
      captures.push({ dom, file, ...metadata });
    };

    await waitFor(
      `() => Boolean(window.controlPanel && document.querySelector('#project-list'))`,
      'the renderer bridge',
    );

    // A clean user-data directory deliberately opens the first-run guide above the workbench. Keep
    // this real-window suite honest: dismiss it with an actual pointer click, wait for the animated
    // close to finish, and verify the workbench is no longer inert before touching controls beneath
    // it. Coordinate-only clicks used to tunnel through this layer and made the first capture look
    // actionable even though a person could not reach the launch button.
    await waitFor(
      `() => document.querySelector('#onboarding-shell')?.dataset.state === 'open' && document.querySelector('#control-panel')?.inert === true`,
      'the seeded first-run guide to open and isolate the workbench',
    );
    await capture('onboarding-first-run-real.png', {
      interaction: 'first-run-guide',
      theme: await evaluate(`document.documentElement.dataset.theme`),
    });
    await click('#onboarding-dismiss');
    await waitFor(
      `() => document.querySelector('#onboarding-shell')?.hidden === true && document.querySelector('#control-panel')?.inert === false`,
      'the first-run guide to finish closing and release the workbench',
    );
    await evaluate(
      `(async () => window.controlPanel.addProject(${JSON.stringify(projectPath)}))()`,
    );
    await waitFor(`() => Boolean(document.querySelector('.conversation-item'))`, 'the project');

    await waitFor(
      `() => document.querySelector('#run-claude')?.disabled === false`,
      'the actionable safe-session button',
    );
    await capture('claude-safe-session-action.png', {
      interaction: 'launch-ready',
      theme: await evaluate(`document.documentElement.dataset.theme`),
    });
    await click('#run-claude');
    await waitFor(
      `() => document.querySelector('#native-conversation')?.dataset.state !== 'open' && !document.querySelector('#terminal-shell')?.classList.contains('terminal-shell--native') && document.querySelector('#run-claude')?.disabled === false && document.querySelector('#toast')?.textContent?.includes('隔离运行配置禁止启动')`,
      'the isolated profile to refuse the primary safe terminal launch',
    );
    await capture('claude-safe-terminal-primary.png', {
      interaction: 'safe-terminal-primary',
      theme: await evaluate(`document.documentElement.dataset.theme`),
    });

    await click('#native-terminal-toggle');
    await waitFor(
      `() => document.querySelector('#native-conversation')?.dataset.state === 'open'`,
      'the explicitly opened native conversation',
    );

    await click('#native-composer-input');
    await client.call('Input.insertText', {
      text: '请检查统一按钮套系、原生对话切换图标与四个主题的视觉一致性。',
    });
    await click('#native-send');
    await waitFor(
      `() => document.querySelectorAll('.native-message').length >= 2`,
      'the fake adapter response',
    );

    for (const theme of ['claude', 'telegram', 'graphite', 'midnight']) {
      await evaluate(`(() => {
        const select = document.querySelector('#terminal-theme');
        select.value = ${JSON.stringify(theme)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await waitFor(
        `() => document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
        `${theme} theme`,
      );
      await capture(`${theme}-native-conversation.png`, {
        interaction: 'theme-change',
        theme,
      });
      await click('.terminal-theme-control .select');
      await waitFor(
        `() => document.querySelector('.select__listbox[data-open="true"]')?.textContent?.includes('Telegram')`,
        `${theme} theme selection card`,
      );
      await capture(`${theme}-theme-menu-open.png`, {
        interaction: 'theme-menu',
        theme,
      });
      await click('#terminal-project');
      await waitFor(
        `() => !document.querySelector('.select__listbox[data-open="true"]')`,
        `${theme} theme selection card close`,
      );

      // R1/R2 evidence, on every theme. `[fixture:hold]` parks the fake turn in `running` with no
      // assistant output, which is the only way this harness can photograph a real in-flight turn:
      // every other fake response resolves inside the submitting tick.
      await click('#native-composer-input');
      await client.call('Input.insertText', { text: `[fixture:hold] ${theme} 发送动效核对` });
      await click('#native-send');
      await waitFor(
        `() => document.querySelector('#native-send')?.dataset.sending === 'true'`,
        `${theme} send confirmation motion`,
      );
      await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        for (const animation of button?.getAnimations({ subtree: true }) ?? []) {
          const duration = animation.effect?.getTiming().duration;
          if (typeof duration !== 'number') continue;
          animation.pause();
          animation.currentTime = duration * 0.5;
        }
        return true;
      })()`);
      await capture(
        `${theme}-send-mid.png`,
        { animation: 'send-mid', interaction: 'send', theme },
        0,
      );
      await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        for (const animation of button?.getAnimations({ subtree: true }) ?? []) animation.cancel();
        return true;
      })()`);
      // Cancelling never fires `animationend`, so the flip below is produced by the renderer's own
      // 600 ms watchdog rather than forced here: the handover is observed, not staged.
      await waitFor(
        `() => document.querySelector('#native-send')?.dataset.action === 'stop' && !document.querySelector('#native-send')?.dataset.stopping`,
        `${theme} send-to-stop handover`,
        5_000,
      );
      await parkPointer();
      // The send-to-stop flip and the un-hover both start background-color transitions, so a sample
      // taken right after parkPointer reads an interpolated colour rather than the resting one.
      // Fast-forwarding the transitions to their end state is what "at rest" actually means here;
      // it cannot mask a real defect, because a stop face that stays painted still ends painted.
      await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        for (const animation of button?.getAnimations({ subtree: true }) ?? []) {
          try {
            animation.finish();
          } catch {
            animation.cancel();
          }
        }
        return true;
      })()`);
      const stopRest = await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        const marker = getComputedStyle(button.querySelector('.native-composer__send-stop'));
        return {
          action: button.dataset.action ?? '(unset)',
          background: getComputedStyle(button).backgroundColor,
          halo: getComputedStyle(button, '::after').animationName,
          haloOpacity: getComputedStyle(button, '::after').opacity,
          markerDisplay: marker.display,
          markerRadius: parseFloat(marker.borderTopLeftRadius),
          markerWidth: parseFloat(marker.width),
          sending: button.dataset.sending ?? '(unset)',
          status: document.querySelector('#native-composer-status')?.textContent ?? '',
          stopIsOnlyButton: document.querySelectorAll('#native-composer button[type="submit"]').length,
          valueLength: document.querySelector('#native-composer-input')?.value.length ?? -1,
        };
      })()`);
      // Report the attribute alongside the colour: a painted background means either the stop rule
      // lost the cascade or the button already flipped back to 'send', and those need opposite fixes.
      if (stopRest.action !== 'stop') {
        throw new Error(
          `${theme} composer left the stop face before it could be sampled (data-action=${stopRest.action}, data-sending=${stopRest.sending}, status="${stopRest.status}").`,
        );
      }
      if (stopRest.background !== 'rgba(0, 0, 0, 0)') {
        throw new Error(`${theme} stop rest must be transparent, saw ${stopRest.background}.`);
      }
      if (stopRest.halo !== 'none' || stopRest.haloOpacity !== '0') {
        throw new Error(`${theme} stop rest must not carry a halo yet.`);
      }
      if (stopRest.markerDisplay !== 'block' || stopRest.markerWidth < 8) {
        throw new Error(`${theme} stop marker is missing or too small: ${stopRest.markerWidth}.`);
      }
      if (stopRest.markerRadius <= 0 || stopRest.markerRadius > stopRest.markerWidth / 2) {
        throw new Error(
          `${theme} stop marker must stay a rounded square, saw ${stopRest.markerRadius}px.`,
        );
      }
      if (stopRest.stopIsOnlyButton !== 1) {
        throw new Error(`${theme} composer must expose exactly one action button.`);
      }
      await capture(`${theme}-stop-rest.png`, { interaction: 'stop-rest', theme }, 0);

      // The halo is forced rather than clicked: a real interrupt resolves in the same tick against
      // the fake adapter, and the idle re-render would strip `data-stopping` before the shutter.
      await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        button.dataset.stopping = 'true';
        return true;
      })()`);
      await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        for (const animation of button?.getAnimations({ subtree: true }) ?? []) {
          const duration = animation.effect?.getTiming().duration;
          if (typeof duration !== 'number') continue;
          animation.pause();
          animation.currentTime = duration * 0.5;
        }
        return true;
      })()`);
      await capture(
        `${theme}-stop-halo-mid.png`,
        { animation: 'halo-mid', interaction: 'stop-halo', theme },
        0,
      );
      await evaluate(`(() => {
        const button = document.querySelector('#native-send');
        for (const animation of button?.getAnimations({ subtree: true }) ?? []) animation.cancel();
        delete button.dataset.stopping;
        return true;
      })()`);

      const footer = await evaluate(`(() => {
        const element = document.querySelector('.terminal-footer');
        const composer = document.querySelector('#native-composer');
        return {
          composerBottom: composer.getBoundingClientRect().bottom,
          controlBarPresent: Boolean(document.querySelector('.native-control-bar')),
          display: getComputedStyle(element).display,
          top: element.getBoundingClientRect().top,
          speed: document.querySelector('#footer-speed')?.textContent ?? '',
          speedDisabled: document.querySelector('#footer-speed')?.disabled ?? true,
        };
      })()`);
      if (footer.display === 'none') {
        throw new Error(`${theme} native mode must keep the status footer mounted.`);
      }
      if (footer.top < footer.composerBottom - 1) {
        throw new Error(`${theme} status footer must sit below the composer.`);
      }
      if (footer.controlBarPresent) {
        throw new Error(`${theme} still renders the retired .native-control-bar.`);
      }
      if (!footer.speed.startsWith('Fast')) {
        throw new Error(
          `${theme} footer must report the native Fast state, saw "${footer.speed}".`,
        );
      }
      await capture(`${theme}-native-footer.png`, { interaction: 'native-footer', theme }, 0);

      // Typing during a live turn must hand the button back to send (R1 #4) and park the text above
      // the send row instead of promoting it into a transcript bubble (R2).
      await click('#native-composer-input');
      await client.call('Input.insertText', { text: `${theme} 排队补充说明` });
      await waitFor(
        `() => document.querySelector('#native-send')?.dataset.action === 'send'`,
        `${theme} send-key restoration while running`,
      );
      const bubblesBeforeQueue = await evaluate(
        `document.querySelectorAll('.native-message').length`,
      );
      await click('#native-send');
      await waitFor(
        `() => document.querySelector('#native-queued')?.hidden === false && document.querySelector('#native-queued')?.dataset.state === 'queued'`,
        `${theme} queued message bar`,
      );
      await parkPointer();
      const queued = await evaluate(`(() => {
        const bar = document.querySelector('#native-queued');
        const row = document.querySelector('.native-composer__row');
        const style = getComputedStyle(bar);
        return {
          bubbles: document.querySelectorAll('.native-message').length,
          composerInput: document.querySelector('#native-composer-input').value,
          gapAboveRow: row.getBoundingClientRect().top - bar.getBoundingClientRect().bottom,
          hint: document.querySelector('#native-queued-hint')?.textContent ?? '',
          isBubble: bar.classList.contains('native-message'),
          borderStyle: style.borderTopStyle,
          parent: bar.parentElement?.id ?? '',
        };
      })()`);
      if (queued.bubbles !== bubblesBeforeQueue) {
        throw new Error(`${theme} queued text must not become a transcript bubble yet.`);
      }
      if (queued.isBubble || queued.borderStyle !== 'dashed') {
        throw new Error(`${theme} queued bar must stay visually distinct from a bubble.`);
      }
      if (queued.parent !== 'native-composer') {
        throw new Error(
          `${theme} queued bar must live inside the composer, saw "${queued.parent}".`,
        );
      }
      // The lower bound is "must not overlap the row", not "must not touch it": a flush bar computes
      // to a few ten-thousandths below zero once the rects are scaled by the device pixel ratio.
      if (queued.gapAboveRow < -0.5 || queued.gapAboveRow > 48) {
        throw new Error(
          `${theme} queued bar must sit just above the send row, saw ${queued.gapAboveRow}px.`,
        );
      }
      if (queued.composerInput !== '') {
        throw new Error(`${theme} composer must be cleared once the text is parked.`);
      }
      await capture(`${theme}-native-queued.png`, { interaction: 'native-queued', theme }, 0);

      // Releasing the held turn drains the queue through the normal idle path, which is also how
      // the theme loop hands a clean, idle conversation to the next iteration.
      await click('#native-queued-send');
      await waitFor(
        `() => document.querySelector('#native-queued')?.hidden === true && document.querySelector('#native-send')?.dataset.action === 'send' && document.querySelectorAll('.native-message').length > ${bubblesBeforeQueue}`,
        `${theme} queued message promotion`,
      );
    }

    await click('#native-composer-input');
    await client.call('Input.insertText', {
      text: '[fixture:full] 请演示工具、权限、提问、计划、MCP 与后台任务。',
    });
    await click('#native-send');
    await waitFor(
      `() => Boolean(document.querySelector('.native-interaction--permission'))`,
      'the permission interaction',
    );
    await capture('midnight-permission-open.png', {
      interaction: 'permission',
      theme: 'midnight',
    });
    await click('.native-interaction--permission .button--primary');
    await waitFor(
      `() => !document.querySelector('.native-interaction--permission') && Boolean(document.querySelector('.native-interaction--question'))`,
      'the question interaction',
    );
    await capture('midnight-question-open.png', {
      interaction: 'question',
      theme: 'midnight',
    });
    await click('.native-interaction--question input');
    await click('.native-interaction--question button[type="submit"]');
    await waitFor(
      `() => !document.querySelector('.native-interaction--question') && Boolean(document.querySelector('.native-interaction--plan'))`,
      'the plan interaction',
    );
    await capture('midnight-plan-card.png', {
      interaction: 'plan-card',
      theme: 'midnight',
    });
    await click('.native-interaction--plan .native-plan-expand');
    await waitFor(`() => document.querySelector('#native-plan-dialog')?.open`, 'the full plan');
    await capture('midnight-plan-open.png', {
      interaction: 'plan-open',
      theme: 'midnight',
    });
    await click('#native-plan-close');
    await delay(70);
    await capture('midnight-plan-exit-mid.png', {
      animation: 'exit-mid',
      interaction: 'plan-close',
      theme: 'midnight',
    });
    await waitFor(
      `() => getComputedStyle(document.querySelector('#native-plan-dialog')).display === 'none'`,
      'the plan discrete display transition',
    );
    await click('.native-interaction--plan .button--primary');
    await waitFor(
      `() => !document.querySelector('.native-interaction--plan') && Boolean(document.querySelector('.native-interaction--mcp'))`,
      'the MCP interaction',
    );
    await capture('midnight-mcp-open.png', {
      interaction: 'mcp',
      theme: 'midnight',
    });
    await click('.native-interaction--mcp input');
    await client.call('Input.insertText', { text: '四主题组件一致性' });
    await click('.native-interaction--mcp button[type="submit"]');
    await waitFor(
      `() => !document.querySelector('.native-interaction--mcp')`,
      'the completed interaction queue',
    );

    await click('#runtime-activity-trigger');
    await waitFor(
      `() => document.querySelector('#runtime-activity-panel')?.dataset.state === 'open'`,
      'the conversation summary inspector',
    );
    await waitFor(
      `() => document.querySelector('#runtime-activity-panel')?.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished')`,
      'the conversation summary entrance animation',
    );
    await capture('midnight-summary-open.png', {
      interaction: 'summary-open',
      theme: 'midnight',
    });
    await click('#runtime-activity-close');
    await delay(30);
    await evaluate(`(() => {
      const panel = document.querySelector('#runtime-activity-panel');
      for (const animation of panel?.getAnimations({ subtree: true }) ?? []) {
        if (animation.playState !== 'running') continue;
        const duration = animation.effect?.getTiming().duration;
        if (typeof duration !== 'number') continue;
        animation.pause();
        animation.currentTime = duration * 0.5;
      }
      return panel?.dataset.state === 'closing';
    })()`);
    await capture(
      'midnight-summary-exit-mid.png',
      {
        animation: 'exit-mid',
        interaction: 'summary-close',
        theme: 'midnight',
      },
      0,
    );

    // The isolated profile refuses to spawn a real PowerShell, so this transfer cannot succeed here
    // by construction — `assertRealRuntimeAllowed` throws inside `restartRuntimeTerminal`. What this
    // step is worth photographing is therefore the *rollback*: the native panel must stay open with
    // a usable composer and re-enabled toggle rather than stranding the user between two surfaces.
    // A profile that allows real runtimes owns the success path; asserting it here would only ever
    // assert that the sandbox leaked.
    await click('#native-terminal-toggle');
    await waitFor(
      `() => document.querySelector('#confirmation-dialog')?.open && document.querySelector('#confirmation-dialog-title')?.textContent === '中断正在运行的任务并切换？'`,
      'the running-work transfer confirmation',
    );
    await capture('midnight-safe-terminal-confirm.png', {
      interaction: 'safe-terminal-confirm',
      theme: 'midnight',
    });
    await click('#confirmation-dialog-confirm');
    await waitFor(
      `() => document.querySelector('#confirmation-dialog')?.open === false`,
      'the running-work transfer confirmation to close',
    );
    await delay(70);
    await capture('midnight-safe-terminal-exit-mid.png', {
      animation: 'exit-mid',
      interaction: 'safe-terminal',
      theme: 'midnight',
    });
    await waitFor(
      `() => document.querySelector('#native-terminal-toggle')?.disabled === false && document.querySelector('#toast')?.textContent?.includes('已尝试恢复原生界面')`,
      'the blocked safe terminal transfer to roll back',
    );
    const rollback = await evaluate(`(() => ({
      composerDisabled: document.querySelector('#native-composer-input')?.disabled ?? '(missing)',
      panelState: document.querySelector('#native-conversation')?.dataset.state ?? '(missing)',
      status: document.querySelector('#native-composer-status')?.textContent ?? '',
    }))()`);
    if (rollback.panelState !== 'open') {
      throw new Error(
        `a refused safe-terminal transfer must leave the native panel open, saw "${rollback.panelState}".`,
      );
    }
    if (rollback.composerDisabled !== false) {
      throw new Error('a refused safe-terminal transfer must hand the composer back to the user.');
    }
    if (rollback.status === '正在安全返回终端…') {
      throw new Error('the composer is still advertising a transfer that already failed.');
    }
    await capture('midnight-safe-terminal.png', {
      interaction: 'safe-terminal',
      theme: 'midnight',
    });

    // Runtime switching is deliberately the final real-window interaction.
    //
    // This step used to claim the active native owner wins the conflict and the switch rolls back.
    // It does not: `runtime:set` gates only on `hasActiveRuntime`, which is PTY-based
    // (`ClaudeRuntime.isActive` reads the workspace-session map), while a native conversation holds
    // its route under `nativeRouteReservations`. Nothing in the switch path consults conversation
    // ownership, so the switch commits. The old assertion never caught this because `waitFor`
    // evaluated an uninvoked arrow function and returned truthy on its first poll.
    //
    // What is actually guaranteed today — and what this now asserts — is that the switch is not
    // destructive: the native transcript, the open panel and a usable composer all survive it,
    // because the route stays reserved (`RouteLifecycleCoordinator.hasUser` counts reservations,
    // not just active PTY sessions). Whether the switch *should* additionally be refused while a
    // native turn is live is an open product question; it is not implemented anywhere in main, the
    // renderer, the root docs or the tests, so this harness must not pretend it is.
    const beforeSwitch = await evaluate(`document.querySelectorAll('.native-message').length`);
    await click('#runtime-disclosure > summary');
    await waitFor(
      `() => document.querySelector('#runtime-disclosure')?.open === true`,
      'the runtime picker disclosure',
    );
    await click("label[for='runtime-codex']");
    await waitFor(
      `() => document.body.dataset.agentRuntime === 'codex' && document.querySelector('#runtime-codex')?.checked && !document.querySelector('#runtime-picker')?.disabled`,
      'the runtime switch to settle',
    );
    const afterSwitch = await evaluate(`(() => ({
      composerDisabled: document.querySelector('#native-composer-input')?.disabled ?? '(missing)',
      messages: document.querySelectorAll('.native-message').length,
      panelState: document.querySelector('#native-conversation')?.dataset.state ?? '(missing)',
    }))()`);
    if (afterSwitch.messages !== beforeSwitch) {
      throw new Error(
        `a runtime switch must not drop native transcript content, saw ${beforeSwitch} then ${afterSwitch.messages}.`,
      );
    }
    if (afterSwitch.panelState !== 'open') {
      throw new Error(
        `a runtime switch must not tear down the live native panel, saw "${afterSwitch.panelState}".`,
      );
    }
    if (afterSwitch.composerDisabled !== false) {
      throw new Error('a runtime switch must leave the native composer usable.');
    }
    await capture('midnight-runtime-switch.png', {
      interaction: 'runtime-switch',
      state: 'native-survives',
      theme: 'midnight',
    });

    writeFileSync(
      path.join(outputRoot, 'manifest.json'),
      `${JSON.stringify(
        {
          captures,
          generatedAt: new Date().toISOString(),
          isolated: true,
          projectPath,
          realElectronWindow: true,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Real Electron visual QA: ${captures.length} captures in ${outputRoot}`);
  } finally {
    try {
      await Promise.race([client?.call('Browser.close'), delay(1_000)]);
    } catch {
      // A renderer failure can close the DevTools target before the browser process exits.
    }
    client?.close();
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      delay(3_000).then(() => false),
    ]);
    if (!exited && !child.killed) child.kill();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    if (stderr && process.env.CLAUDEDOCK_VISUAL_DEBUG === '1') {
      console.error(stderr);
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
