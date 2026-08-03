const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const repositoryRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(repositoryRoot, 'dist', 'visual-qa');
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedock-conpty-'));
const workspaceDirectory = path.join(userDataDirectory, 'claude');
const now = Date.now();

app.setPath('userData', userDataDirectory);
fs.mkdirSync(workspaceDirectory, { recursive: true });
fs.writeFileSync(
  path.join(workspaceDirectory, 'workspace.json'),
  `${JSON.stringify(
    {
      lastActiveProject: repositoryRoot,
      projects: [
        {
          addedAt: now,
          lastActiveAt: now,
          path: repositoryRoot,
        },
      ],
      terminalTheme: 'claude',
      version: 1,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

require('../dist/main/main.js');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const scheduleTemporaryUserDataCleanup = () => {
  const cleanupSource = String.raw`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const target = path.resolve(process.argv[1]);
    const parentPid = Number(process.argv[2]);
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(temporaryRoot) || !path.basename(target).startsWith('claudedock-conpty-')) {
      process.exit(2);
    }
    const waitForParent = () => {
      try {
        process.kill(parentPid, 0);
        setTimeout(waitForParent, 100);
        return;
      } catch {}
      try {
        fs.rmSync(target, { force: true, maxRetries: 40, recursive: true, retryDelay: 100 });
      } catch {
        process.exitCode = 3;
      }
    };
    waitForParent();
  `;
  const cleanup = spawn(
    process.execPath,
    ['-e', cleanupSource, userDataDirectory, String(process.pid)],
    {
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  cleanup.unref();
};

const waitFor = async (probe, timeoutMilliseconds, description) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`等待 ${description} 超时（${timeoutMilliseconds}ms）。`);
};

const run = async () => {
  await app.whenReady();
  await waitFor(
    () => BrowserWindow.getAllWindows().some((candidate) => !candidate.isDestroyed()),
    10_000,
    '主窗口',
  );

  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!window) {
    throw new Error('主窗口不存在。');
  }

  await waitFor(
    () =>
      window.webContents
        .executeJavaScript(
          `Boolean(document.querySelector('#composer-input') && !document.querySelector('#composer-input').disabled)`,
          true,
        )
        .catch(() => false),
    20_000,
    'ConPTY 启动',
  );

  await window.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('#composer-input');
      const form = document.querySelector('#terminal-composer');
      input.value = "1..24 | ForEach-Object { 'resize-proof-' + $_ }";
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()`,
    true,
  );
  await delay(1_000);

  const resizeSequence = [
    { height: 720, width: 820 },
    { height: 900, width: 1_400 },
    { height: 680, width: 900 },
    { height: 860, width: 1_280 },
    { height: 760, width: 1_180 },
  ];
  for (const bounds of resizeSequence) {
    window.setBounds({ ...window.getBounds(), ...bounds }, false);
    await delay(350);
  }

  await window.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('#composer-input');
      const form = document.querySelector('#terminal-composer');
      input.value = "'RESIZE-COMPLETE ' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height";
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()`,
    true,
  );
  await delay(1_200);

  const state = await window.webContents.executeJavaScript(
    `(() => {
      const stage = document.querySelector('#terminal-stage');
      const mask = document.querySelector('#terminal-operation-mask');
      const rect = stage.getBoundingClientRect();
      return {
        composerEnabled: !document.querySelector('#composer-input').disabled,
        maskHidden: !mask || mask.hidden,
        rect: {
          height: Math.max(1, Math.floor(rect.height)),
          width: Math.max(1, Math.floor(rect.width)),
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
        },
      };
    })()`,
    true,
  );

  if (!state.composerEnabled || !state.maskHidden) {
    throw new Error(`缩放后终端状态异常：${JSON.stringify(state)}`);
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const image = await window.webContents.capturePage(state.rect);
  const outputPath = path.join(outputDirectory, 'conpty-resize-live.png');
  fs.writeFileSync(outputPath, image.toPNG());
  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: 'live-conpty',
        outputPath,
        resizeSequence,
        terminalRect: state.rect,
      },
      null,
      2,
    )}\n`,
  );
};

run()
  .then(() => {
    scheduleTemporaryUserDataCleanup();
    // This is a one-shot test host. `app.quit()` enters ClaudeDock's user-facing busy/tray
    // handshake and can keep the harness alive after the screenshot has already passed. Exiting the
    // harness directly closes the ConPTY handles; the detached helper then removes its temp data.
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    scheduleTemporaryUserDataCleanup();
    app.exit(1);
  });
