/*
 * End-to-end bootstrap check for the Xray-core kernel: probe every route, download through the
 * fastest one, extract it, and prove the result actually runs — the exact chain that had never once
 * completed on the reporting machine (`proxy/core/` did not exist and the download journal was `[]`).
 *
 * Needs internet. It runs against a scratch userData directory so it can never disturb a real
 * install, and it starts the tunnel with a throwaway outbound purely to prove the kernel boots; no
 * traffic is sent through it and it is stopped immediately.
 *
 * Usage:
 *   electron scripts/xray-core-install-smoke.cjs                        # direct
 *   electron scripts/xray-core-install-smoke.cjs http://127.0.0.1:10808 # via a bootstrap proxy
 *   KEEP_CORE=1 electron scripts/xray-core-install-smoke.cjs            # reuse the last download
 */
const { app, session } = require('electron');
const { rmSync } = require('node:fs');
const path = require('node:path');
const { BusyRegistry } = require('../dist/main/busy-registry.js');
const { DownloadEngine } = require('../dist/main/download-engine.js');
const { XraySidecar } = require('../dist/main/proxy/xray-sidecar.js');

const BOOTSTRAP = process.argv[2];
const SCRATCH = path.join(__dirname, '..', 'dist', '.electron-core-install-smoke');

app.setPath('userData', SCRATCH);

const throwawayProfile = {
  address: 'example.invalid',
  credentials: { password: 'smoke-only-never-connected' },
  hasCredentials: true,
  id: 'smoke',
  port: 443,
  protocol: 'trojan',
  remark: 'smoke',
  security: 'tls',
  serverName: 'example.invalid',
  tls: true,
  transport: 'tcp',
  updatedAt: 1,
};

app.whenReady().then(async () => {
  // A fresh install is the point of this script; KEEP_CORE is only for iterating on the start path.
  if (!process.env.KEEP_CORE) {
    rmSync(SCRATCH, { force: true, recursive: true });
  }
  const target = session.defaultSession;
  if (BOOTSTRAP) {
    await target.setProxy({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: BOOTSTRAP,
    });
  }

  const busyRegistry = new BusyRegistry();
  const sidecar = new XraySidecar({
    busyRegistry,
    downloadEngine: new DownloadEngine(target, busyRegistry, SCRATCH),
    fetchImpl: (url, init) => target.fetch(url, init),
    userDataPath: SCRATCH,
  });

  console.log(`bootstrap: ${BOOTSTRAP ?? '直连'}`);
  console.log(`before:    installed=${sidecar.getCoreView().installed}`);

  const startedAt = Date.now();
  let exitCode = 0;
  try {
    const runtime = await sidecar.start(throwawayProfile);
    const core = sidecar.getCoreView();
    console.log(`after:     installed=${core.installed} version=${core.installedVersion}`);
    console.log(`route:     ${core.sources.find((source) => source.status === 'ok')?.label}`);
    console.log(`tunnel:    ${runtime.status} ${runtime.httpProxyUrl ?? ''}`);
    console.log(`elapsed:   ${Date.now() - startedAt}ms`);
    await sidecar.stop();
  } catch (error) {
    exitCode = 1;
    console.log(`FAILED after ${Date.now() - startedAt}ms:\n${error?.message ?? error}`);
    // The kernel state and the tunnel log are the two things the panel would be showing right now.
    console.log(`installed: ${sidecar.getCoreView().installed}`);
    for (const line of sidecar.getView().logs.slice(-25)) {
      console.log(`  log  ${line}`);
    }
    await sidecar.stop().catch(() => undefined);
  }
  /*
   * The scratch directory stays behind on purpose: Chromium still holds handles to it while this
   * process is alive, so deleting it here only ever produced an EPERM that buried the real result.
   * The run above already wipes it on entry, which is the point at which it can actually be removed.
   */
  console.log(`scratch:   ${SCRATCH}`);
  app.exit(exitCode);
});
