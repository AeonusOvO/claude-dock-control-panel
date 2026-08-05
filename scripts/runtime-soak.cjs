const { createServer } = require('node:http');
const { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const accelerated = process.argv.includes('--accelerated');
const hoursArgument = process.argv.find((argument) => argument.startsWith('--hours='));
const durationHours = hoursArgument ? Number(hoursArgument.slice('--hours='.length)) : 24;
if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 48) {
  throw new Error('--hours 必须在 0–48 之间。');
}

const realDurationMs = accelerated ? 8_000 : durationHours * 60 * 60 * 1_000;
const virtualTickMs = accelerated ? 60_000 : 1_000;
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-runtime-soak-'));
const eventsDirectory = path.join(fixtureRoot, 'events');
mkdirSync(eventsDirectory, { recursive: true });
const servers = new Set();
let createdEvents = 0;
let recycledServers = 0;

const listen = () =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => response.end('ok'));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      servers.add(server);
      resolve(server);
    });
  });

const close = (server) =>
  new Promise((resolve) => {
    server.close(() => {
      servers.delete(server);
      resolve();
    });
  });

const run = async () => {
  const startedAt = Date.now();
  let virtualElapsedMs = 0;
  while (Date.now() - startedAt < realDurationMs) {
    const eventId = `${Date.now()}-${createdEvents}`;
    const temporary = path.join(eventsDirectory, `${eventId}.tmp`);
    const final = path.join(eventsDirectory, `${eventId}.json`);
    writeFileSync(
      temporary,
      JSON.stringify({
        event: createdEvents % 2 === 0 ? 'SubagentStart' : 'SubagentStop',
        eventId,
        launchGeneration: Math.floor(createdEvents / 120) + 1,
        ptyGeneration: Math.floor(createdEvents / 120) + 1,
        signaledAt: Date.now(),
      }),
      'utf8',
    );
    renameSync(temporary, final);
    rmSync(final, { force: true });
    createdEvents += 1;
    virtualElapsedMs += virtualTickMs;

    if (createdEvents % 25 === 0) {
      const server = await listen();
      await close(server);
      recycledServers += 1;
    }
    if (!accelerated) await new Promise((resolve) => setTimeout(resolve, 1_000));
    else if (createdEvents % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
    if (accelerated && virtualElapsedMs >= durationHours * 60 * 60 * 1_000) break;
  }
  if (servers.size !== 0) throw new Error(`仍有 ${servers.size} 个本地 Web 服务未关闭。`);
  process.stdout.write(
    `${JSON.stringify({ accelerated, createdEvents, durationHours, recycledServers })}\n`,
  );
};

run()
  .finally(() => {
    const resolved = path.resolve(fixtureRoot);
    if (resolved.startsWith(path.resolve(tmpdir()) + path.sep)) {
      rmSync(resolved, { force: true, recursive: true });
    }
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
