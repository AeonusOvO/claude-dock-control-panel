const { app, net, session } = require('electron');
const { strict: assert } = require('node:assert');
const { mkdtempSync } = require('node:fs');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');
const packaged = process.argv.includes('--packaged');
const applicationRoot = packaged
  ? path.join(root, 'outputs', 'win-unpacked', 'resources', 'app.asar')
  : root;
const temporary = mkdtempSync(path.join(tmpdir(), 'claudedock-chatgpt-quota-'));
app.setPath('userData', path.join(root, 'dist', '.electron-chatgpt-quota-smoke'));
const moduleAt = (file) => require(path.join(applicationRoot, 'dist', 'main', file));
const { ManagedChatGptQuotaReader } = moduleAt('claude/managed-chatgpt-quota.js');
const { ModelUsageService } = moduleAt('usage/service.js');
const { createElectronSessionFetch } = moduleAt('network/electron-request.js');
const officialUrl = 'https://chatgpt.com/backend-api/wham/usage';

const until = async (condition, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('ChatGPT quota smoke timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const removeFixture = async () => {
  if (
    path.dirname(temporary) !== path.resolve(tmpdir()) ||
    !path.basename(temporary).startsWith('claudedock-chatgpt-quota-')
  )
    throw new Error('Unsafe quota fixture cleanup');
  await rm(temporary, { recursive: true, force: true });
};

const run = async () => {
  const userData = path.join(temporary, '其他用户 应用数据');
  const authDirectory = path.join(userData, 'managed-gateways', 'cliproxyapi', 'auth');
  const authFile = path.join(authDirectory, 'codex-owned.json');
  await mkdir(authDirectory, { recursive: true });
  await writeFile(
    authFile,
    JSON.stringify({
      type: 'codex',
      disabled: false,
      email: 'smoke@example.com',
      account_id: 'smoke-account',
      access_token: 'smoke-access',
      refresh_token: 'smoke-refresh',
      id_token: 'smoke-id',
      expired: '2099-01-01T00:00:00Z',
      last_refresh: '2026-08-28T00:00:00Z',
    }),
  );
  const originalAuth = await readFile(authFile);
  let mode = 'success';
  let requests = 0;
  let publishQuotaInvalidated;
  let publishQuotaReadable;
  let stalledConnectionClosed = false;
  let fixtureFailure;
  const server = createServer((request, response) => {
    requests++;
    try {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, 'Bearer smoke-access');
      assert.equal(request.headers['chatgpt-account-id'], 'smoke-account');
      assert.equal(request.headers.cookie, undefined);
    } catch (error) {
      fixtureFailure = error;
      response.writeHead(500).end();
      return;
    }
    if (request.url === '/slow') {
      request.socket.once('close', () => {
        stalledConnectionClosed = true;
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      return;
    }
    if (request.url === '/unauthorized') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{"error":"smoke-access must not escape"}');
      return;
    }
    if (request.url === '/oversize') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('x'.repeat(65537));
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          rate_limit: {
            primary_window: null,
            secondary_window: {
              used_percent: 8,
              limit_window_seconds: 604800,
              reset_at: 2000600000,
            },
          },
        }),
      );
    }, 150);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const network = session.fromPartition(`claudedock-quota-smoke-${process.pid}`);
  await network.setProxy({ mode: 'direct' });
  const electronFetch = createElectronSessionFetch({
    requestFactory: (options) => net.request(options),
    resolveProxyCredentials: () => undefined,
    session: network,
  });
  const reader = new ManagedChatGptQuotaReader(
    authDirectory,
    async (url, init) => {
      assert.equal(url, officialUrl);
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      // Test-only endpoint substitution: exercise the production Electron transport with synthetic
      // credentials and a local fixture; the shipped reader has no configurable upstream URL.
      const response = await electronFetch(`http://127.0.0.1:${address.port}/${mode}`, init);
      Object.defineProperty(response, 'url', { value: officialUrl });
      return response;
    },
    () => true,
  );
  const usage = new ModelUsageService({
    userDataPath: userData,
    projectsRoot: path.join(userData, 'projects'),
    onChanged() {},
    readChatGptQuota: (signal, model) => reader.read(model, signal),
    subscribeChatGptQuotaInvalidated: (listener) => {
      publishQuotaInvalidated = listener;
      return () => {
        if (publishQuotaInvalidated === listener) publishQuotaInvalidated = undefined;
      };
    },
    subscribeChatGptQuotaReadable: (listener) => {
      publishQuotaReadable = listener;
      return () => {
        if (publishQuotaReadable === listener) publishQuotaReadable = undefined;
      };
    },
  });
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  try {
    mode = 'slow';
    usage.select({
      id: 'owned-account',
      mode: 'subscription',
      preset: 'chatgpt-subscription',
      model: 'gpt-5.3-codex',
    });
    await until(() => requests === 1);
    assert.equal(typeof publishQuotaInvalidated, 'function');
    assert.equal(typeof publishQuotaReadable, 'function');
    reader.invalidate();
    publishQuotaInvalidated();
    mode = 'success';
    publishQuotaReadable();
    await until(() => usage.getSnapshot().status === 'available');
    assert.equal(usage.getSnapshot().windows[0].remainingPercent, 92);
    assert.equal(usage.getSnapshot().windows[0].label, '7 天');
    assert.equal(requests, 2);
    assert.doesNotMatch(
      JSON.stringify(usage.getSnapshot()),
      /smoke-access|smoke-refresh|smoke-id|accountKey/,
    );
    mode = 'unauthorized';
    assert.match((await reader.read('gpt-5.3-codex')).detail, /授权已失效/);
    mode = 'oversize';
    assert.match((await reader.read('gpt-5.3-codex')).detail, /格式暂不兼容/);
    mode = 'slow';
    assert.match((await reader.read('gpt-5.3-codex')).detail, /查询超时/);
    await until(() => stalledConnectionClosed, 3000);
    assert.equal(fixtureFailure, undefined);
    assert.equal(requests, 5);
    assert.deepEqual(await readFile(authFile), originalAuth);
    delay.disable();
    const maxMainDelayMs = delay.max / 1e6;
    assert.ok(maxMainDelayMs < 250, `Quota I/O blocked the main process: ${maxMainDelayMs} ms`);
    const report = {
      packaged,
      version: require(path.join(applicationRoot, 'package.json')).version,
      electron: process.versions.electron,
      requests,
      remainingPercent: 92,
      relocatedUnicodeDataDirectory: true,
      independentCodexLogin: false,
      authUnchanged: true,
      stalledConnectionClosed,
      maxMainDelayMs,
    };
    await mkdir(path.join(root, 'dist', 'visual-qa'), { recursive: true });
    await writeFile(
      path.join(root, 'dist', 'visual-qa', 'chatgpt-quota.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    delay.disable();
    usage.dispose();
    reader.invalidate();
    await usage.writes;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

app
  .whenReady()
  .then(run)
  .then(
    async () => {
      await removeFixture();
      app.exit(0);
    },
    async (error) => {
      console.error(error.message);
      await removeFixture();
      app.exit(1);
    },
  );
