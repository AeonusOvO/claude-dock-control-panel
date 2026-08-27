const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, net, session } = require('electron');
const { createElectronSessionFetch } = require('../../dist/main/network/electron-request.js');

// A real Electron ClientRequest closes its upload Writable before the URLLoader response. Mocks
// alone missed that ordering. This regression uses only a test-owned loopback server, no account.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedock-network-smoke-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
const results = [];
const sockets = new Set();
const server = http.createServer((request, response) => {
  if (request.url === '/never') return;
  if (request.url === '/redirect') {
    setTimeout(() => response.writeHead(302, { location: '/slow' }).end(), 20);
    return;
  }
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first-');
    if (request.url === '/truncated') {
      setTimeout(() => response.destroy(), 30);
    } else {
      setTimeout(() => response.end('last'), 30);
    }
  }, 20);
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

const watchdog = setTimeout(() => {
  console.error('Network request smoke exceeded its 30 second deadline.');
  app.exit(1);
}, 30_000);

async function run() {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let earlyCloses = 0;
  const fetch = createElectronSessionFetch({
    authorizeRedirect: ({ targetUrl }) => assert.equal(targetUrl.origin, base),
    requestFactory: (options) => {
      const request = net.request(options);
      let responded = false;
      request.on('response', () => {
        responded = true;
      });
      request.on('close', () => {
        if (!responded) earlyCloses += 1;
      });
      return request;
    },
    resolveProxyCredentials: () => undefined,
    session: session.fromPartition('network-smoke'),
  });

  await Promise.all(
    Array.from({ length: 10 }, async () => {
      const response = await fetch(`${base}/redirect`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200);
      assert.equal(response.url, `${base}/slow`);
      assert.equal(await response.text(), 'first-last');
    }),
  );
  results.push('ten concurrent delayed redirects and streamed responses');

  const head = await fetch(`${base}/slow`, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  results.push('HEAD response after upload close');

  const truncated = await fetch(`${base}/truncated`, { signal: AbortSignal.timeout(5_000) });
  await assert.rejects(truncated.text());
  results.push('truncated response still fails');

  const controller = new AbortController();
  const reason = new Error('test-owned cancellation');
  const never = fetch(`${base}/never`, { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 30);
  await assert.rejects(never, (error) => error === reason);
  results.push('cancellation remains effective after upload close');

  const report = { electron: process.versions.electron, earlyCloses, results };
  const directory = path.resolve(__dirname, '../../dist/visual-qa');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'network-request.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
}

run().then(
  () => finish(0),
  (error) => {
    console.error(error);
    finish(1);
  },
);
function finish(code) {
  clearTimeout(watchdog);
  for (const socket of sockets) socket.destroy();
  server.close();
  app.exit(code);
}
