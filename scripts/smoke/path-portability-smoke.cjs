const { app } = require('electron');
const { strict: assert } = require('node:assert');
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const packaged = process.argv.includes('--packaged');
const applicationRoot = packaged
  ? path.join(root, 'outputs', 'win-unpacked', 'resources', 'app.asar')
  : root;
const temporary = mkdtempSync(path.join(tmpdir(), 'claudedock-portable-'));
const userData = path.join(temporary, '其他用户 应用数据');
mkdirSync(userData);
app.setPath('userData', path.join(root, 'dist', '.electron-path-portability-smoke'));

const moduleAt = (file) => require(path.join(applicationRoot, 'dist', 'main', file));
const { NetworkDiagnosticsStore } = moduleAt('network/diagnostics-store.js');
const { NetworkPreflightService } = moduleAt('network/preflight-service.js');
const { ProviderAccessGuard } = moduleAt('network/provider-access-guard.js');
const { ProviderConnectivityProbe } = moduleAt('network/provider-connectivity-probe.js');

const cleanup = () => {
  if (
    path.dirname(temporary) !== path.resolve(tmpdir()) ||
    !path.basename(temporary).startsWith('claudedock-portable-')
  ) {
    throw new Error('Unsafe portability fixture cleanup');
  }
  rmSync(temporary, { recursive: true, force: true });
};

app
  .whenReady()
  .then(async () => {
    const profile = path.join(userData, 'claude', 'next-conversation-profile');
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        authenticated: Boolean(request.headers.authorization || request.headers.cookie),
      });
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert(address && typeof address !== 'string');
      const probe = new ProviderConnectivityProbe({
        applicationRequest: async () => ({ contentType: '', redirects: [], status: 204 }),
        cliEnvironment: () => ({
          ALL_PROXY: null,
          all_proxy: null,
          HTTP_PROXY: null,
          http_proxy: null,
          HTTPS_PROXY: null,
          https_proxy: null,
          NO_PROXY: '*',
          no_proxy: '*',
        }),
        dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
        resolveProxy: async () => 'DIRECT',
      });
      const service = new NetworkPreflightService({
        acquireNetworkLease: async (requested) => {
          const scopes = typeof requested === 'string' ? [requested] : requested;
          return {
            scopes,
            epochs: Object.fromEntries(scopes.map((scope) => [scope, 'smoke-epoch'])),
            assertCurrent() {},
            release() {},
          };
        },
        diagnosticsStore: new NetworkDiagnosticsStore(userData),
        probe,
        probeWorkingDirectory: userData,
      });
      const guard = new ProviderAccessGuard(service);
      const request = {
        action: 'login',
        cwd: profile,
        provider: 'openai-codex',
        target: { process: 'claude-cli', url: `http://127.0.0.1:${address.port}/probe` },
      };
      let admitted = 0;
      await guard.withAllowed(request, async (result) => {
        assert.equal(result.canonicalCwd, profile);
        admitted++;
        await guard.withAllowed(request, () => {
          admitted++;
        });
        await assert.rejects(
          guard.withAllowed(
            { ...request, cwd: path.join(userData, 'different-profile') },
            () => {},
          ),
        );
      });
      assert.equal(admitted, 2);
      assert.equal(existsSync(profile), false);
      assert.deepEqual(requests, [{ method: 'GET', authenticated: false }]);
      console.log(
        JSON.stringify({
          packaged,
          version: require(path.join(applicationRoot, 'package.json')).version,
          electron: process.versions.electron,
          admitted,
          requests,
          logicalProfileCreated: existsSync(profile),
          relocatedUnicodeDataDirectory: true,
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  })
  .then(
    () => {
      cleanup();
      app.exit(0);
    },
    (error) => {
      console.error(error.message);
      cleanup();
      app.exit(1);
    },
  );
