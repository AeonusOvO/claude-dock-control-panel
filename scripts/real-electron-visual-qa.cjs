const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outputRoot = path.join(root, 'dist', 'visual-qa', 'real-electron');
const isolatedRoot = path.join(
  root,
  'dist',
  '.electron-real-visual-qa',
  `run-${Date.now().toString(36)}`,
);
const userData = path.join(isolatedRoot, 'userData');
const fakeHome = path.join(isolatedRoot, 'home');
const projects = path.join(isolatedRoot, 'projects');
const projectPath = path.join(projects, 'native-conversation-visual-project');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

for (const directory of [outputRoot, userData, fakeHome, projects, projectPath]) {
  mkdirSync(directory, { recursive: true });
}

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

const expression = (source) => `(${source})`;

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
      return result.result?.value;
    };

    const waitFor = async (source, label, timeout = 15_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression(source))) return;
        await delay(100);
      }
      throw new Error(`Timed out waiting for ${label}.`);
    };

    const elementCenter = async (selector) => {
      const value = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!value) throw new Error(`Missing real-window element: ${selector}`);
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

    const capture = async (file, metadata) => {
      await delay(80);
      const result = await client.call('Page.captureScreenshot', {
        captureBeyondViewport: false,
        format: 'png',
        fromSurface: true,
      });
      const bytes = Buffer.from(result.data, 'base64');
      if (bytes.length < 1_000) throw new Error(`Invalid real Electron capture: ${file}`);
      writeFileSync(path.join(outputRoot, file), bytes);
      const dom = await evaluate(`(() => ({
        nativeState: document.querySelector('#native-conversation')?.dataset.state ?? '',
        redundantModelStatus: Boolean(document.querySelector('#native-model-status')),
        summaryState: document.querySelector('#runtime-activity-panel')?.dataset.state ?? '',
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
    await evaluate(
      `(async () => window.controlPanel.addProject(${JSON.stringify(projectPath)}))()`,
    );
    await waitFor(`() => Boolean(document.querySelector('.conversation-item'))`, 'the project');

    await evaluate(`(() => {
      const button = document.querySelector('#run-claude');
      button.disabled = false;
      button.removeAttribute('aria-disabled');
      return true;
    })()`);
    await click('#run-claude');
    await waitFor(
      `() => document.querySelector('#native-conversation')?.dataset.state === 'open'`,
      'the native conversation',
    );

    await click('#native-composer-input');
    await client.call('Input.insertText', {
      text: '请检查统一按钮套系、顶部高级终端图标与四个主题的视觉一致性。',
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
      `() => !document.querySelector('#native-plan-dialog')?.open`,
      'the plan close animation',
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
    await capture('midnight-summary-open.png', {
      interaction: 'summary-open',
      theme: 'midnight',
    });
    await click('#runtime-activity-close');
    await delay(70);
    await capture('midnight-summary-exit-mid.png', {
      animation: 'exit-mid',
      interaction: 'summary-close',
      theme: 'midnight',
    });

    await click('#native-terminal-toggle');
    await delay(70);
    await capture('midnight-advanced-terminal-exit-mid.png', {
      animation: 'exit-mid',
      interaction: 'advanced-terminal',
      theme: 'midnight',
    });
    await waitFor(
      `() => document.querySelector('#native-conversation')?.dataset.state === 'closed'`,
      'the advanced terminal transition',
    );
    await capture('midnight-advanced-terminal.png', {
      interaction: 'advanced-terminal',
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
