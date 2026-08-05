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
    await delay(50);
  }
  throw new Error(`等待 ${description} 超时（${timeoutMilliseconds}ms）。`);
};

const installLifecycleRecorder = (window) =>
  window.webContents.executeJavaScript(
    `(() => {
      window.__claudeDockConptyLifecycle?.dispose?.();
      const recorder = {
        events: [],
        nextSequence: 1,
        dispose: undefined,
      };
      const record = (event) => {
        recorder.events.push({ ...event, sequence: recorder.nextSequence });
        recorder.nextSequence += 1;
      };
      const unsubscribeData = window.controlPanel.onTerminalData(
        (sessionId, ptyGeneration, data) =>
          record({ data, kind: 'data', ptyGeneration, sessionId }),
      );
      const unsubscribeSize = window.controlPanel.onTerminalSize(
        (sessionId, ptyGeneration, cols, rows) =>
          record({ cols, kind: 'size', ptyGeneration, rows, sessionId }),
      );
      const unsubscribeState = window.controlPanel.onWorkspaceState((state) =>
        record({ kind: 'state', state }),
      );
      recorder.dispose = () => {
        unsubscribeData();
        unsubscribeSize();
        unsubscribeState();
      };
      window.__claudeDockConptyLifecycle = recorder;
      return true;
    })()`,
    true,
  );

const submitComposerCommand = (window, command) =>
  window.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('#composer-input');
      const form = document.querySelector('#terminal-composer');
      input.value = ${JSON.stringify(command)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()`,
    true,
  );

const terminalOutputContains = (window, marker, sessionId, ptyGeneration) =>
  window.webContents
    .executeJavaScript(
      `(() => window.__claudeDockConptyLifecycle.events
        .filter((event) =>
          event.kind === 'data' &&
          ${sessionId === undefined ? 'true' : `event.sessionId === ${JSON.stringify(sessionId)}`} &&
          ${ptyGeneration === undefined ? 'true' : `event.ptyGeneration === ${ptyGeneration}`}
        )
        .map((event) => event.data)
        .join('')
        .includes(${JSON.stringify(marker)}))()`,
      true,
    )
    .catch(() => false);

const terminalSizeEventCount = (window) =>
  window.webContents.executeJavaScript(
    `window.__claudeDockConptyLifecycle.events.filter((event) => event.kind === 'size').length`,
    true,
  );

const lifecycleStateObserved = (window, sessionId, ptyGeneration, phase) =>
  window.webContents
    .executeJavaScript(
      `window.__claudeDockConptyLifecycle.events.some(
        (event) => event.kind === 'state' && event.state.sessions.some(
          (session) =>
            session.id === ${JSON.stringify(sessionId)} &&
            session.ptyGeneration === ${ptyGeneration} &&
            session.phase === ${JSON.stringify(phase)}
        )
      )`,
      true,
    )
    .catch(() => false);

const assertLifecycleOrdering = (events, sessionId, finalGeneration, sentinel) => {
  const finalRunningSequence = events.find(
    (event) =>
      event.kind === 'state' &&
      event.state.sessions.some(
        (session) =>
          session.id === sessionId &&
          session.ptyGeneration === finalGeneration &&
          session.phase === 'running',
      ),
  )?.sequence;
  const finalStoppedSequence = events.find(
    (event) =>
      event.kind === 'state' &&
      event.state.sessions.some(
        (session) =>
          session.id === sessionId &&
          session.ptyGeneration === finalGeneration &&
          session.phase === 'stopped',
      ),
  )?.sequence;

  let accumulatedFinalOutput = '';
  let sentinelSequence;
  for (const event of events) {
    if (
      event.kind === 'data' &&
      event.sessionId === sessionId &&
      event.ptyGeneration === finalGeneration
    ) {
      accumulatedFinalOutput += event.data;
      if (sentinelSequence === undefined && accumulatedFinalOutput.includes(sentinel)) {
        sentinelSequence = event.sequence;
      }
    }
  }

  if (finalRunningSequence === undefined) {
    throw new Error('未观察到最终 ConPTY generation 的 running 状态。');
  }
  if (sentinelSequence === undefined || finalStoppedSequence === undefined) {
    throw new Error('未同时观察到最终 sentinel 输出和 stopped 状态。');
  }
  if (sentinelSequence >= finalStoppedSequence) {
    throw new Error(
      `最终输出顺序错误：sentinel=${sentinelSequence}, stopped=${finalStoppedSequence}`,
    );
  }

  const staleTerminalState = events.find((event) => {
    if (
      event.kind !== 'state' ||
      event.sequence <= finalRunningSequence ||
      event.sequence >= finalStoppedSequence
    ) {
      return false;
    }
    return event.state.sessions.some(
      (session) =>
        session.id === sessionId &&
        session.ptyGeneration < finalGeneration &&
        (session.phase === 'error' || session.phase === 'stopped'),
    );
  });
  if (staleTerminalState) {
    throw new Error(
      `旧 generation 在最终终端运行期间覆盖状态：${JSON.stringify(staleTerminalState)}`,
    );
  }

  const dataAfterStopped = events.find(
    (event) =>
      event.kind === 'data' &&
      event.sessionId === sessionId &&
      event.ptyGeneration === finalGeneration &&
      event.sequence > finalStoppedSequence,
  );
  if (dataAfterStopped) {
    throw new Error(`最终 stopped 后仍收到同 generation 输出：${JSON.stringify(dataAfterStopped)}`);
  }

  return { finalRunningSequence, finalStoppedSequence, sentinelSequence };
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
  await installLifecycleRecorder(window);

  const initialWorkspace = await window.webContents.executeJavaScript(
    `window.controlPanel.getWorkspace()`,
    true,
  );
  const initialSession = initialWorkspace.sessions.find(
    (session) => session.id === initialWorkspace.activeSessionId,
  );
  if (!initialSession || initialSession.phase !== 'running') {
    throw new Error(`初始 ConPTY 状态异常：${JSON.stringify(initialWorkspace)}`);
  }

  await submitComposerCommand(window, `1..24 | ForEach-Object { 'resize-proof-' + $_ }`);
  await waitFor(() => terminalOutputContains(window, 'resize-proof-24'), 10_000, '缩放测试输出');

  const resizeSequence = [
    { height: 720, width: 820 },
    { height: 900, width: 1_400 },
    { height: 680, width: 900 },
    { height: 860, width: 1_280 },
    { height: 760, width: 1_180 },
  ];
  for (const bounds of resizeSequence) {
    const previousSizeEventCount = await terminalSizeEventCount(window);
    window.setBounds({ ...window.getBounds(), ...bounds }, false);
    await waitFor(
      async () => (await terminalSizeEventCount(window)) > previousSizeEventCount,
      5_000,
      `ConPTY 尺寸确认 ${bounds.width}x${bounds.height}`,
    );
  }

  await submitComposerCommand(
    window,
    `'RESIZE-COMPLETE ' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height`,
  );
  await waitFor(() => terminalOutputContains(window, 'RESIZE-COMPLETE'), 10_000, '最终尺寸输出');

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

  const lifecycle = await window.webContents.executeJavaScript(
    `(async () => {
      const workspace = await window.controlPanel.getWorkspace();
      let current = workspace.sessions.find((session) => session.id === workspace.activeSessionId);
      if (!current || current.phase !== 'running') {
        throw new Error('No running session is available for lifecycle testing.');
      }
      const cycles = [];
      for (let index = 0; index < 3; index += 1) {
        const restarted = await window.controlPanel.restartTerminal(
          current.id,
          current.ptyGeneration,
        );
        if (!restarted.ok || !restarted.status || restarted.status.phase !== 'running') {
          throw new Error('Restart failed: ' + JSON.stringify(restarted));
        }
        const stopped = await window.controlPanel.stopTerminal(
          current.id,
          restarted.status.ptyGeneration,
        );
        if (!stopped.ok || !stopped.status || stopped.status.phase !== 'stopped') {
          throw new Error('Stop failed: ' + JSON.stringify(stopped));
        }
        const started = await window.controlPanel.startTerminal(
          current.id,
          stopped.status.ptyGeneration,
        );
        if (!started.ok || !started.status || started.status.phase !== 'running') {
          throw new Error('Start failed: ' + JSON.stringify(started));
        }
        cycles.push({ restarted: restarted.status, started: started.status, stopped: stopped.status });
        current = started.status;
      }
      return {
        cycles,
        finalStatus: current,
        initialStatus: workspace.sessions.find((session) => session.id === workspace.activeSessionId),
      };
    })()`,
    true,
  );

  const { finalStatus, initialStatus } = lifecycle;
  if (
    !initialStatus ||
    finalStatus.ptyGeneration <= initialStatus.ptyGeneration ||
    lifecycle.cycles.some(
      (cycle) =>
        cycle.restarted.ptyGeneration <= initialStatus.ptyGeneration ||
        cycle.stopped.ptyGeneration !== cycle.restarted.ptyGeneration ||
        cycle.started.ptyGeneration <= cycle.stopped.ptyGeneration,
    )
  ) {
    throw new Error(`ConPTY generation 未按周期单调推进：${JSON.stringify(lifecycle)}`);
  }
  await waitFor(
    () => lifecycleStateObserved(window, finalStatus.id, finalStatus.ptyGeneration, 'running'),
    5_000,
    '最终 running 状态',
  );

  const sentinelPrefix = 'CLAUDEDOCK-CONPTY-SENTINEL-';
  const sentinel = `${sentinelPrefix}${process.pid}`;
  const sentinelCommand = `Write-Output ('${sentinelPrefix}' + ${process.pid}); exit\r`;
  if (sentinelCommand.includes(sentinel)) {
    throw new Error('ConPTY sentinel 命令不得包含最终 sentinel 原文。');
  }
  await window.webContents.executeJavaScript(
    `window.controlPanel.writeTerminal(
      ${JSON.stringify(finalStatus.id)},
      ${finalStatus.ptyGeneration},
      ${JSON.stringify(sentinelCommand)}
    )`,
    true,
  );
  await waitFor(
    async () =>
      (await terminalOutputContains(window, sentinel, finalStatus.id, finalStatus.ptyGeneration)) &&
      (await lifecycleStateObserved(window, finalStatus.id, finalStatus.ptyGeneration, 'stopped')),
    10_000,
    'sentinel 输出和最终 stopped 状态',
  );

  // An IPC round trip plus two renderer frames drains messages already queued before stopped without
  // relying on an arbitrary lifecycle sleep. Anything recorded afterwards is genuinely late.
  await window.webContents.executeJavaScript(
    `(async () => {
      await window.controlPanel.getWorkspace();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`,
    true,
  );
  const lifecycleEvents = await window.webContents.executeJavaScript(
    `window.__claudeDockConptyLifecycle.events`,
    true,
  );
  const ordering = assertLifecycleOrdering(
    lifecycleEvents,
    finalStatus.id,
    finalStatus.ptyGeneration,
    sentinel,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: 'live-conpty',
        lifecycleCycles: lifecycle.cycles.map((cycle) => ({
          restartedGeneration: cycle.restarted.ptyGeneration,
          startedGeneration: cycle.started.ptyGeneration,
          stoppedGeneration: cycle.stopped.ptyGeneration,
        })),
        ordering,
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
