const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');
const applicationRoot = process.argv.includes('--packaged')
  ? path.join(root, 'outputs', 'win-unpacked', 'resources', 'app.asar')
  : root;
const temporary = mkdtempSync(path.join(tmpdir(), 'claudedock-model-usage-smoke-'));
app.setPath('userData', path.join(root, 'dist', '.electron-model-usage-smoke'));
app.on('window-all-closed', () => {});
Object.defineProperty(app, 'getAppPath', { value: () => applicationRoot });
const moduleAt = (file) => require(path.join(applicationRoot, 'dist', 'main', file));
const { ModelUsageService } = moduleAt('usage/service.js');
const { ModelUsageWindow } = moduleAt('app/model-usage-window.js');
const { Registry } = moduleAt('infra/registry.js');
const { MODEL_USAGE_SERVICE, MODEL_USAGE_WINDOW } = moduleAt('infra/service-tokens.js');
const { registerModelUsageIpc } = moduleAt('ipc/model-usage.js');
const { claudeProjectDirectoryName } = moduleAt('claude/session-manager.js');

const removeFixture = () => {
  if (!temporary.startsWith(path.join(tmpdir(), 'claudedock-model-usage-smoke-')))
    throw new Error('Unsafe fixture cleanup');
  rmSync(temporary, { recursive: true, force: true });
};

const until = async (condition, timeout = 25000) => {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Model usage smoke timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

app
  .whenReady()
  .then(async () => {
    const services = new Registry();
    const widget = new ModelUsageWindow((visible) => usage.setFloating(visible));
    const projects = path.join(temporary, 'projects');
    const usage = new ModelUsageService({
      userDataPath: temporary,
      projectsRoot: projects,
      onChanged: (snapshot) => widget.publish(snapshot),
      readChatGptQuota: async () => undefined,
    });
    services.register(MODEL_USAGE_SERVICE, () => usage);
    services.register(MODEL_USAGE_WINDOW, () => widget);
    registerModelUsageIpc({
      services,
      guards: {
        validateSender: () => {
          throw new Error('Unowned sender');
        },
        assertLaunchAdmissionAllowed: () => {},
      },
    });
    const connection = {
      id: 'smoke-account',
      mode: 'api',
      preset: 'deepseek',
      model: 'deepseek-chat',
    };
    usage.select(connection, true);
    const cwd = path.join(temporary, 'example-project');
    const directory = path.join(projects, claudeProjectDirectoryName(cwd));
    mkdirSync(directory, { recursive: true });
    const sessionId = '00000000-1111-2222-3333-444444444444';
    const count = 12000;
    const timestamp = new Date(Date.now() + 1).toISOString();
    const records =
      Array.from({ length: count }, (_, index) =>
        JSON.stringify({
          type: 'assistant',
          timestamp,
          message: {
            id: `msg-${index}`,
            content: [{ type: 'text', text: 'fixture '.repeat(120) }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 40,
            },
          },
        }),
      ).join('\n') + '\n';
    writeFileSync(path.join(directory, `${sessionId}.jsonl`), records);
    try {
      await widget.setVisible(true);
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === 'ClaudeDock 模型用量',
      );
      assert.ok(window);
      assert.ok(window.isAlwaysOnTop());
      assert.equal(
        await window.webContents.executeJavaScript('typeof window.controlPanel'),
        'undefined',
      );
      assert.equal(
        await window.webContents.executeJavaScript('typeof window.modelUsage.getModelUsage'),
        'function',
      );
      assert.equal(
        await window.webContents.executeJavaScript('Object.keys(window.modelUsage).length'),
        3,
      );
      await until(() => usage.getSnapshot().floating);
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      for (let index = 0; index < 200; index += 1) usage.observe(connection, cwd, sessionId);
      await until(() => usage.getSnapshot().tokens?.input === count * 100);
      delay.disable();
      const maxMainDelayMs = delay.max / 1e6;
      assert.ok(maxMainDelayMs < 250, `background reader blocked main: ${maxMainDelayMs} ms`);
      const reportDirectory = path.join(root, 'dist', 'visual-qa');
      mkdirSync(reportDirectory, { recursive: true });
      for (const theme of ['claude', 'graphite', 'midnight', 'telegram']) {
        usage.setTheme(theme);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const displayed = await window.webContents.executeJavaScript(`({
        value: document.querySelector('[data-usage-value]').textContent,
        background: getComputedStyle(document.querySelector('#usage-ball')).backgroundColor,
        height: document.body.scrollHeight, width: document.body.scrollWidth,
        viewportWidth: innerWidth, viewportHeight: innerHeight
      })`);
        assert.equal(displayed.value, '228万');
        assert.notEqual(displayed.background, 'rgba(0, 0, 0, 0)');
        assert.ok(
          displayed.width <= displayed.viewportWidth &&
            displayed.height <= displayed.viewportHeight,
          JSON.stringify(displayed),
        );
        writeFileSync(
          path.join(reportDirectory, `model-usage-ball-${theme}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      const subscription = { ...connection, mode: 'subscription', preset: 'anthropic' };
      usage.select(subscription, true);
      usage.observe(usage.capture(subscription), cwd, sessionId, {
        capturedAt: Date.now(),
        rateLimitFiveHour: 25,
        rateLimitSevenDay: 62,
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-usage-value]').textContent`,
        ),
        '38%',
      );
      writeFileSync(
        path.join(reportDirectory, 'model-usage-ball-quota.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await window.webContents.executeJavaScript('window.modelUsage.setModelUsageFloating(false)');
      await until(() => !usage.getSnapshot().floating);
      await widget.setVisible(true);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      const report = {
        workerRecords: count,
        inputTokens: count * 100,
        totalTokens: count * 190,
        maxMainDelayMs,
        themes: 4,
        restrictedPreload: true,
        alwaysOnTop: true,
        reopen: true,
      };
      writeFileSync(
        path.join(reportDirectory, 'model-usage.json'),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
    } finally {
      widget.dispose();
      usage.dispose();
      await usage.writes;
      removeFixture();
    }
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
