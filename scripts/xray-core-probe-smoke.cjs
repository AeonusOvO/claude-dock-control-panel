/*
 * Live reachability report for the Xray-core download routes.
 *
 * The offline guard for the multi-source logic is tests/xray-core-sources.test.ts; this script
 * answers the question that no unit test can — whether the built-in mirror list is actually usable
 * from the network the app happens to be on today. Mirror domains churn constantly, so this is the
 * tool to re-run before a release and whenever a user reports 「所有下载线路都不可用」.
 *
 * It probes through Electron's default session, which is the same path `DownloadEngine` takes, so a
 * route reported `ok` here is a route the real download can use.
 *
 * Usage:
 *   electron scripts/xray-core-probe-smoke.cjs                        # direct, as a fresh install
 *   electron scripts/xray-core-probe-smoke.cjs http://127.0.0.1:10808 # through a bootstrap proxy
 */
const { app, session } = require('electron');
const path = require('node:path');
const {
  buildXrayCoreSources,
  describeProbeFailure,
  pickFastestSource,
  probeXrayCoreSources,
} = require('../dist/main/proxy/xray-core-sources.js');
const { XRAY_CORE_RELEASE } = require('../dist/main/proxy/xray-sidecar.js');

const BOOTSTRAP = process.argv[2];

app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-probe-smoke'));

app.whenReady().then(async () => {
  const target = session.defaultSession;
  if (BOOTSTRAP) {
    await target.setProxy({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: BOOTSTRAP,
    });
  }

  const sources = buildXrayCoreSources(XRAY_CORE_RELEASE);
  const startedAt = Date.now();
  const results = await probeXrayCoreSources(sources, {
    fetchImpl: (url, init) => target.fetch(url, init),
    release: XRAY_CORE_RELEASE,
  });

  console.log(`route          via ${BOOTSTRAP ?? '直连'}   (${XRAY_CORE_RELEASE.version})`);
  for (const source of sources) {
    const result = results.find((candidate) => candidate.id === source.id);
    const latency = result?.latencyMs === undefined ? '' : `${result.latencyMs}ms`;
    const rate =
      result?.throughputBps === undefined ? '' : `${(result.throughputBps / 1024).toFixed(0)} KB/s`;
    console.log(
      [
        source.host.padEnd(24),
        (result?.status ?? 'unknown').padEnd(8),
        latency.padStart(7),
        rate.padStart(11),
        result?.detail ?? '',
      ]
        .join(' ')
        .trimEnd(),
    );
  }

  const fastest = pickFastestSource(sources, results);
  console.log(
    fastest
      ? `\nwould download from: ${fastest.label}\n${fastest.url}`
      : `\n${describeProbeFailure(sources, results)}`,
  );
  console.log(`\nprobed ${sources.length} routes in ${Date.now() - startedAt}ms`);
  app.exit(fastest ? 0 : 1);
});
