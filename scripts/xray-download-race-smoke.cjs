/*
 * Reproduction harness for the Xray-core bootstrap stalling at 0%.
 *
 * Variant `control` downloads through Electron's default session untouched.
 * Variant `teardown` replays what ClaudeDock did on the first built-in-proxy start before the fix:
 * the sidecar's `setView` listener fires `applyApplicationProxyScope()` without awaiting it, so a
 * `setProxy` + `closeAllConnections()` pair lands a moment after `downloadURL()` opened the socket.
 * On the machine this was diagnosed on, `control` reached ~750 KB while `teardown` finished at 0
 * bytes with `cancelled (canResume=false)` — the stall the download center reported after 60 s.
 *
 * Needs internet: it pulls a real Xray-core release asset from GitHub. `npm run test:xray-download`
 * runs the control variant; the deterministic, offline guard for the fix is the
 * `starting`/`stopped` rules invariant in tests/proxy-environment.test.ts.
 *
 * Usage: electron scripts/xray-download-race-smoke.cjs [control|teardown]
 */
const { app, session } = require('electron');
const path = require('node:path');

const VARIANT = process.argv[2] === 'teardown' ? 'teardown' : 'control';
const URL_UNDER_TEST =
  'https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-windows-64.zip';
const OBSERVE_MS = 20_000;
const TEARDOWN_DELAY_MS = 250;

app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-download-smoke'));

app.whenReady().then(async () => {
  const target = session.defaultSession;
  let received = 0;
  let interruptions = 0;
  let doneState = '(still running)';
  let sawFirstByte = 0;
  const startedAt = Date.now();

  target.on('will-download', (_event, item) => {
    item.setSavePath(path.join(app.getPath('userData'), 'probe.partial'));
    item.on('updated', (_updated, state) => {
      received = item.getReceivedBytes();
      if (received > 0 && !sawFirstByte) {
        sawFirstByte = Date.now() - startedAt;
      }
      if (state === 'interrupted') {
        interruptions += 1;
      }
    });
    item.on('done', (_done, state) => {
      doneState = `${state} (canResume=${item.canResume()})`;
    });
  });

  target.downloadURL(URL_UNDER_TEST);

  if (VARIANT === 'teardown') {
    setTimeout(() => {
      void (async () => {
        await target.setProxy({ mode: 'system' });
        await target.closeAllConnections();
        console.log(`[${VARIANT}] applied setProxy(system) + closeAllConnections()`);
      })();
    }, TEARDOWN_DELAY_MS);
  }

  setTimeout(() => {
    console.log(
      JSON.stringify(
        {
          variant: VARIANT,
          receivedBytes: received,
          firstByteMs: sawFirstByte || null,
          interruptions,
          doneState,
          observedMs: OBSERVE_MS,
        },
        null,
        2,
      ),
    );
    app.exit(0);
  }, OBSERVE_MS);
});
