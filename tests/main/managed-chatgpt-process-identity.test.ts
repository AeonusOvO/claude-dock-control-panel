import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../../src/main/infra/windows-command';
import {
  ManagedGatewayProcessIdentity,
  type ManagedGatewayExactProcess,
} from '../../src/main/claude/managed-chatgpt-process-identity';

const descriptor = (): ManagedGatewayExactProcess => ({
  configPath: path.resolve('C:\\ClaudeDock Secret\\config.yaml'),
  executablePath: path.resolve('C:\\ClaudeDock Secret\\cli-proxy-api.exe'),
  identity: { startedAtTicks: '638900000000000042', version: 1 },
  port: 8317,
  processId: 42,
});

const runner = (stdout: string) =>
  vi.fn(async () => ({
    stderr: '',
    stdout,
  }));

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

const availableLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port assigned.');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
};

describe('managed gateway exact Windows process identity', () => {
  it('captures only a normalized non-secret birth token through fixed script text', async () => {
    const run = runner('MATCH:638900000000000042');
    const identity = new ManagedGatewayProcessIdentity({ platform: 'win32', run });
    const process = descriptor();

    await expect(
      identity.capture({
        configPath: process.configPath,
        executablePath: process.executablePath,
        port: process.port,
        processId: process.processId,
      }),
    ).resolves.toEqual({ startedAtTicks: '638900000000000042', version: 1 });

    expect(run).toHaveBeenCalledOnce();
    const [executable, argumentsList, environment, options] =
      (run.mock.calls as unknown[][])[0] ?? [];
    const script = (argumentsList as string[]).at(-1) ?? '';
    expect(executable).toBe('powershell.exe');
    expect(argumentsList as string[]).toContain('-NonInteractive');
    expect(script).not.toContain(process.configPath);
    expect(script).not.toContain(process.executablePath);
    expect(script).toContain('CommandLineToArgvW');
    expect(script).toContain('CharSet = CharSet.Unicode');
    expect(script).toContain('[MarshalAs(UnmanagedType.LPWStr)]');
    expect(environment).toMatchObject({
      CLAUDEDOCK_GATEWAY_PROCESS_CONFIG: process.configPath,
      CLAUDEDOCK_GATEWAY_PROCESS_EXE: process.executablePath,
      CLAUDEDOCK_GATEWAY_PROCESS_MODE: 'capture',
      CLAUDEDOCK_GATEWAY_PROCESS_PID: '42',
      CLAUDEDOCK_GATEWAY_PROCESS_PORT: '8317',
    });
    expect(options).toEqual({ maxBuffer: 4 * 1024, timeout: 5_000 });
    expect(
      JSON.stringify(await identity.capture({ ...process, identity: undefined } as never)),
    ).not.toContain(process.configPath);
  });

  it.each([
    { expected: 'match', output: 'MATCH' },
    { expected: 'absent', output: 'ABSENT' },
    { expected: 'mismatch', output: 'MISMATCH' },
    { expected: 'inaccessible', output: 'INACCESSIBLE' },
    { expected: 'inaccessible', output: 'unexpected output' },
  ] as const)('maps an inspect $output result to $expected', async ({ expected, output }) => {
    const run = runner(output);
    const identity = new ManagedGatewayProcessIdentity({ platform: 'win32', run });

    await expect(identity.matches(descriptor(), 321)).resolves.toBe(expected);
    expect((run.mock.calls as unknown[][])[0]?.[2]).toMatchObject({
      CLAUDEDOCK_GATEWAY_PROCESS_BIRTH: '638900000000000042',
      CLAUDEDOCK_GATEWAY_PROCESS_MODE: 'inspect',
    });
    expect((run.mock.calls as unknown[][])[0]?.[3]).toEqual({
      maxBuffer: 4 * 1024,
      timeout: 321,
    });
  });

  it('rejects malformed birth identity without invoking a PID operation', async () => {
    const run = runner('MATCH');
    const identity = new ManagedGatewayProcessIdentity({ platform: 'win32', run });
    const malformed = {
      ...descriptor(),
      identity: { startedAtTicks: '42', version: 1 as const },
    };

    await expect(identity.matches(malformed)).resolves.toBe('mismatch');
    await expect(identity.terminate(malformed)).resolves.toBe('mismatch');
    await expect(
      identity.ownsEstablishedConnection({ clientPort: 50_000, process: malformed }),
    ).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('requires the exact established client tuple before reporting ownership', async () => {
    const run = runner('MATCH');
    const identity = new ManagedGatewayProcessIdentity({ platform: 'win32', run });

    await expect(
      identity.ownsEstablishedConnection({ clientPort: 49_321, process: descriptor() }, 456),
    ).resolves.toBe(true);
    expect((run.mock.calls as unknown[][])[0]?.[2]).toMatchObject({
      CLAUDEDOCK_GATEWAY_PROCESS_BIRTH: '638900000000000042',
      CLAUDEDOCK_GATEWAY_PROCESS_CLIENT_PORT: '49321',
      CLAUDEDOCK_GATEWAY_PROCESS_MODE: 'connection',
      CLAUDEDOCK_GATEWAY_PROCESS_PID: '42',
      CLAUDEDOCK_GATEWAY_PROCESS_PORT: '8317',
    });
    await expect(
      identity.ownsEstablishedConnection({ clientPort: 0, process: descriptor() }),
    ).resolves.toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    { expected: 'terminated', output: 'TERMINATED' },
    { expected: 'timeout', output: 'TIMEOUT' },
    { expected: 'mismatch', output: 'MISMATCH' },
    { expected: 'mismatch', output: 'ABSENT' },
    { expected: 'inaccessible', output: 'INACCESSIBLE' },
  ] as const)('maps exact-instance termination result $output', async ({ expected, output }) => {
    const run = runner(output);
    const identity = new ManagedGatewayProcessIdentity({ platform: 'win32', run });

    await expect(identity.terminate(descriptor(), 789)).resolves.toBe(expected);
    const call = (run.mock.calls as unknown[][])[0] ?? [];
    const script = ((call[1] as string[] | undefined)?.at(-1) ?? '').replaceAll('\r', '');
    expect(script).toContain('taskkill.exe');
    expect(script).toContain("'/F' '/T' '/PID'");
    expect(script).toContain('Process handle open');
    expect(script).not.toContain('.Kill($true)');
    expect(call[2]).toMatchObject({
      CLAUDEDOCK_GATEWAY_PROCESS_BIRTH: '638900000000000042',
      CLAUDEDOCK_GATEWAY_PROCESS_MODE: 'terminate',
    });
    expect(call[3]).toEqual({ maxBuffer: 4 * 1024, timeout: 789 });
  });

  it.runIf(process.platform === 'win32' && process.env.CLAUDEDOCK_WINDOWS_INTEGRATION === '1')(
    'captures and terminates one real exact Windows process tree without killing a mismatch',
    async () => {
      const executablePath = process.env.ComSpec ?? path.join('C:\\Windows', 'System32', 'cmd.exe');
      const nonce = `${process.pid}-${Date.now()}`;
      const configPath = path.join(tmpdir(), `claudedock-helper-${nonce}.yaml`);
      const descendantPidPath = path.join(tmpdir(), `claudedock-helper-child-${nonce}.txt`);
      const child = spawn(executablePath, ['-config', configPath], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      expect(child.pid).toBeTypeOf('number');
      const processId = child.pid!;
      const helperResults: string[] = [];
      const identity = new ManagedGatewayProcessIdentity({
        run: async (...argumentsList) => {
          const result = await runProcess(...argumentsList);
          helperResults.push(result.stdout.trim());
          return result;
        },
      });
      let descendantProcessId: number | undefined;

      try {
        await expect(
          identity.capture(
            { configPath: `${configPath}.wrong`, executablePath, port: 8317, processId },
            5_000,
          ),
        ).resolves.toBeUndefined();
        const birth = await identity.capture(
          { configPath, executablePath, port: 8317, processId },
          5_000,
        );
        expect(birth, `helper results: ${helperResults.join(', ')}`).toEqual({
          startedAtTicks: expect.stringMatching(/^\d{10,20}$/),
          version: 1,
        });
        await expect(
          identity.terminate(
            {
              configPath,
              executablePath,
              identity: { startedAtTicks: '638900000000000000', version: 1 },
              port: 8317,
              processId,
            },
            5_000,
          ),
        ).resolves.toBe('mismatch');
        expect(child.exitCode).toBeNull();

        const escapedPidPath = descendantPidPath.replaceAll("'", "''");
        child.stdin.write(
          `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$PID | Set-Content -LiteralPath '${escapedPidPath}' -Encoding Ascii; Start-Sleep -Seconds 300"\r\n`,
        );
        expect(await waitUntil(() => existsSync(descendantPidPath), 5_000)).toBe(true);
        descendantProcessId = Number.parseInt(readFileSync(descendantPidPath, 'utf8').trim(), 10);
        expect(descendantProcessId).toBeGreaterThan(0);

        await expect(
          identity.terminate(
            { configPath, executablePath, identity: birth!, port: 8317, processId },
            8_000,
          ),
        ).resolves.toBe('terminated');
        expect(await waitUntil(() => child.exitCode !== null, 3_000)).toBe(true);
        expect(
          await waitUntil(() => {
            try {
              process.kill(descendantProcessId!, 0);
              return false;
            } catch {
              return true;
            }
          }, 3_000),
        ).toBe(true);
      } finally {
        if (child.exitCode === null) {
          spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(processId)], {
            stdio: 'ignore',
            windowsHide: true,
          });
        }
        rmSync(descendantPidPath, { force: true });
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'win32' && process.env.CLAUDEDOCK_WINDOWS_INTEGRATION === '1')(
    'verifies a real exact Windows listener and established loopback tuple',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'claudedock-helper-listener-'));
      const sourcePath = path.join(root, 'GatewayFixture.cs');
      const executablePath = path.join(root, 'gateway-fixture.exe');
      const configPath = path.join(root, 'config.yaml');
      const readyPath = `${configPath}.ready`;
      const compiler = path.join(
        process.env.WINDIR ?? 'C:\\Windows',
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      );
      const port = await availableLoopbackPort();
      writeFileSync(
        sourcePath,
        String.raw`using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
public static class GatewayFixture {
  public static void Main(string[] args) {
    int port = Int32.Parse(File.ReadAllText(args[1]));
    TcpListener listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    File.WriteAllText(args[1] + ".ready", "ready");
    using (TcpClient client = listener.AcceptTcpClient()) {
      Thread.Sleep(300000);
    }
  }
}`,
        'utf8',
      );
      writeFileSync(configPath, String(port), 'utf8');
      const compilation = spawnSync(
        compiler,
        ['/nologo', '/target:exe', `/out:${executablePath}`, sourcePath],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(compilation.status, compilation.stderr || compilation.stdout).toBe(0);
      const child = spawn(executablePath, ['-config', configPath], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => {});
      expect(child.pid).toBeTypeOf('number');
      const processId = child.pid!;
      const identityVerifier = new ManagedGatewayProcessIdentity();
      let socket: ReturnType<typeof createConnection> | undefined;

      try {
        expect(await waitUntil(() => existsSync(readyPath), 5_000)).toBe(true);
        const birth = await identityVerifier.capture(
          { configPath, executablePath, port, processId },
          5_000,
        );
        expect(birth).toEqual({
          startedAtTicks: expect.stringMatching(/^\d{10,20}$/),
          version: 1,
        });
        const exact = { configPath, executablePath, identity: birth!, port, processId };
        await expect(identityVerifier.matches(exact, 5_000)).resolves.toBe('match');
        await expect(
          identityVerifier.matches({ ...exact, configPath: `${configPath}.wrong` }, 5_000),
        ).resolves.toBe('mismatch');
        expect(child.exitCode).toBeNull();

        socket = createConnection({ host: '127.0.0.1', port });
        await new Promise<void>((resolve, reject) => {
          socket!.once('connect', resolve);
          socket!.once('error', reject);
        });
        const clientPort = socket.localPort;
        expect(clientPort).toBeTypeOf('number');
        await expect(
          identityVerifier.ownsEstablishedConnection(
            { clientPort: clientPort!, process: exact },
            5_000,
          ),
        ).resolves.toBe(true);
        await expect(
          identityVerifier.ownsEstablishedConnection(
            {
              clientPort: clientPort === 65_535 ? 65_534 : clientPort! + 1,
              process: exact,
            },
            5_000,
          ),
        ).resolves.toBe(false);

        await expect(identityVerifier.terminate(exact, 8_000)).resolves.toBe('terminated');
        expect(await waitUntil(() => child.exitCode !== null, 3_000)).toBe(true);
      } finally {
        socket?.destroy();
        if (child.exitCode === null) {
          spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(processId)], {
            stdio: 'ignore',
            windowsHide: true,
          });
        }
        rmSync(root, { force: true, recursive: true });
      }
    },
    30_000,
  );

  it('fails closed without launching a helper on unsupported platforms', async () => {
    const run = runner('MATCH');
    const identity = new ManagedGatewayProcessIdentity({ platform: 'linux', run });

    await expect(identity.matches(descriptor())).resolves.toBe('inaccessible');
    await expect(identity.terminate(descriptor())).resolves.toBe('inaccessible');
    await expect(
      identity.ownsEstablishedConnection({ clientPort: 49_321, process: descriptor() }),
    ).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
