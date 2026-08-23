import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS } from '../../src/main/claude/managed-chatgpt-model-reconciliation';
import { ManagedGatewayOwnedModelReader } from '../../src/main/claude/managed-chatgpt-owned-models';
import {
  ManagedGatewayProcessIdentity,
  type ManagedGatewayExactProcess,
} from '../../src/main/claude/managed-chatgpt-process-identity';

const servers = new Set<Server>();

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

const listen = async (
  handler: (socket: Socket) => void,
): Promise<{ port: number; server: Server }> => {
  const server = createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return { port: address.port, server };
};

const closeServer = async (server: Server): Promise<void> => {
  if (!servers.delete(server)) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const exactProcess = (port: number): ManagedGatewayExactProcess => ({
  configPath: path.resolve('C:\\ClaudeDock\\config.yaml'),
  executablePath: path.resolve('C:\\ClaudeDock\\cli-proxy-api.exe'),
  identity: { startedAtTicks: '638900000000000042', version: 1 },
  port,
  processId: 42,
});

const httpResponse = (body: string, status = 200, headers: readonly string[] = []): string =>
  [
    `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Unavailable'}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...headers,
    '',
    body,
  ].join('\r\n');

const responseAfterRequest = (
  socket: Socket,
  response: string | ((request: string) => string),
  onRequest?: (request: string) => void,
): void => {
  let request = '';
  socket.on('data', (chunk: Buffer) => {
    request += chunk.toString('utf8');
    if (!request.includes('\r\n\r\n')) return;
    onRequest?.(request);
    socket.end(typeof response === 'string' ? response : response(request), 'utf8');
  });
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...servers].map((server) => closeServer(server)));
});

describe('managed gateway exact-owner model transport', () => {
  it('writes Authorization only after proving the exact established tuple and revalidates afterward', async () => {
    const events: string[] = [];
    let observedRequest = '';
    const { port, server } = await listen((socket) => {
      responseAfterRequest(
        socket,
        httpResponse(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.4-mini' }] })),
        (request) => {
          events.push('request');
          observedRequest = request;
        },
      );
    });
    const processIdentity = {
      matches: vi.fn(async () => {
        events.push('revalidated');
        return 'match' as const;
      }),
      ownsEstablishedConnection: vi.fn(async () => {
        events.push('owned');
        return true;
      }),
    };
    const reader = new ManagedGatewayOwnedModelReader({ processIdentity });
    const credential = `sk-claudedock-${'x'.repeat(43)}`;

    await expect(reader.read(exactProcess(port), credential, 1_000)).resolves.toEqual([
      'gpt-5.6-sol',
      'gpt-5.4-mini',
    ]);
    expect(events).toEqual(['owned', 'request', 'revalidated']);
    expect(observedRequest).toContain('GET /v1/models HTTP/1.1\r\n');
    expect(observedRequest).toContain(`Authorization: Bearer ${credential}\r\n`);
    expect(processIdentity.ownsEstablishedConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientPort: expect.any(Number),
        process: exactProcess(port),
      }),
      expect.any(Number),
    );
    await closeServer(server);
  });

  it('gives each Windows identity helper a 3 second execution budget within 8 seconds overall', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const identityTimeouts: number[] = [];
    const { port, server } = await listen((socket) => {
      responseAfterRequest(socket, httpResponse(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] })));
    });
    const reader = new ManagedGatewayOwnedModelReader({
      processIdentity: {
        matches: vi.fn(async (_process, timeoutMs) => {
          identityTimeouts.push(timeoutMs);
          now += 1_250;
          return 'match' as const;
        }),
        ownsEstablishedConnection: vi.fn(async (_connection, timeoutMs) => {
          identityTimeouts.push(timeoutMs);
          now += 1_250;
          return true;
        }),
      },
    });

    await expect(
      reader.read(exactProcess(port), `sk-claudedock-${'b'.repeat(43)}`, 8_000),
    ).resolves.toEqual(['gpt-5.6-sol']);
    expect(identityTimeouts).toEqual([3_000, 3_000]);
    await closeServer(server);
  });

  it('sends zero HTTP or bearer bytes to a loopback binder that fails ownership proof', async () => {
    const received: Buffer[] = [];
    const { port, server } = await listen((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
    });
    const processIdentity = {
      matches: vi.fn(async () => 'match' as const),
      ownsEstablishedConnection: vi.fn(async () => false),
    };
    const reader = new ManagedGatewayOwnedModelReader({ processIdentity });
    const credential = `sk-claudedock-${'s'.repeat(43)}`;

    const failure = reader.read(exactProcess(port), credential, 500);
    await expect(failure).rejects.toThrow('不属于托管网关进程');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Buffer.concat(received)).toHaveLength(0);
    expect(JSON.stringify(await failure.catch((error: unknown) => String(error)))).not.toContain(
      credential,
    );
    expect(processIdentity.matches).not.toHaveBeenCalled();
    await closeServer(server);
  });

  it('bounds a never-settling tuple-owner query without transmitting bytes', async () => {
    const received: Buffer[] = [];
    const { port, server } = await listen((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
    });
    const reader = new ManagedGatewayOwnedModelReader({
      processIdentity: {
        matches: vi.fn(async () => 'match' as const),
        ownsEstablishedConnection: vi.fn(() => new Promise<boolean>(() => {})),
      },
    });

    const startedAt = Date.now();
    await expect(
      reader.read(exactProcess(port), `sk-claudedock-${'t'.repeat(43)}`, 75),
    ).rejects.toThrow('本机托管网关模型检查超时');
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(Buffer.concat(received)).toHaveLength(0);
    await closeServer(server);
  });

  it('rejects identity drift after the response instead of publishing models', async () => {
    const { port, server } = await listen((socket) => {
      responseAfterRequest(socket, httpResponse(JSON.stringify({ data: [{ id: 'stale-model' }] })));
    });
    const reader = new ManagedGatewayOwnedModelReader({
      processIdentity: {
        matches: vi.fn(async () => 'mismatch' as const),
        ownsEstablishedConnection: vi.fn(async () => true),
      },
    });

    await expect(
      reader.read(exactProcess(port), `sk-claudedock-${'i'.repeat(43)}`, 1_000),
    ).rejects.toThrow('响应后托管网关进程身份已经失效');
    await closeServer(server);
  });

  it.each([
    {
      expected: '没有返回有效 JSON',
      response: httpResponse('{'),
      title: 'malformed JSON',
    },
    {
      expected: 'HTTP 503',
      response: httpResponse('', 503),
      title: 'failed HTTP',
    },
    {
      expected: '超过安全大小上限',
      response: 'HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n',
      title: 'oversized body',
    },
    {
      expected: '无效 HTTP 数据',
      response: `${'X'.repeat(65 * 1024)}\r\n\r\n`,
      title: 'oversized headers',
    },
  ])('rejects a $title response within the exact-owner channel', async ({ expected, response }) => {
    const { port, server } = await listen((socket) => responseAfterRequest(socket, response));
    const reader = new ManagedGatewayOwnedModelReader({
      processIdentity: {
        matches: vi.fn(async () => 'match' as const),
        ownsEstablishedConnection: vi.fn(async () => true),
      },
    });

    await expect(
      reader.read(exactProcess(port), `sk-claudedock-${'e'.repeat(43)}`, 1_000),
    ).rejects.toThrow(expected);
    await closeServer(server);
  });

  it('decodes a bounded chunked model response and filters credential-shaped model IDs', async () => {
    const credential = `sk-claudedock-${'c'.repeat(43)}`;
    const body = JSON.stringify({
      data: [{ id: `prefix-${credential}` }, { id: 'safe-chat-model' }],
    });
    const chunked = [
      'HTTP/1.1 200 OK',
      'Transfer-Encoding: chunked',
      '',
      `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
    ].join('\r\n');
    const { port, server } = await listen((socket) => responseAfterRequest(socket, chunked));
    const reader = new ManagedGatewayOwnedModelReader({
      processIdentity: {
        matches: vi.fn(async () => 'match' as const),
        ownsEstablishedConnection: vi.fn(async () => true),
      },
    });

    await expect(reader.read(exactProcess(port), credential, 1_000)).resolves.toEqual([
      'safe-chat-model',
    ]);
    await closeServer(server);
  });

  it('times out a silent exact-owner server without exposing the credential in the error', async () => {
    let accepted: Socket | undefined;
    const { port, server } = await listen((socket) => {
      accepted = socket;
    });
    const reader = new ManagedGatewayOwnedModelReader({
      processIdentity: {
        matches: vi.fn(async () => 'match' as const),
        ownsEstablishedConnection: vi.fn(async () => true),
      },
    });
    const credential = `sk-claudedock-${'z'.repeat(43)}`;

    const result = await reader
      .read(exactProcess(port), credential, 75)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain('本机托管网关模型检查超时');
    expect(String(result)).not.toContain(credential);
    accepted?.destroy();
    await closeServer(server);
  });

  it.runIf(process.platform === 'win32' && process.env.CLAUDEDOCK_WINDOWS_INTEGRATION === '1')(
    'reads models through the real exact-process checks within the production readiness budget',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'claudedock-owned-model-reader-'));
      const sourcePath = path.join(root, 'GatewayFixture.cs');
      const executablePath = path.join(root, 'gateway-fixture.exe');
      const configPath = path.join(root, 'config.yaml');
      const readyPath = `${configPath}.ready`;
      const requestResultPath = `${configPath}.request-result`;
      const compiler = path.join(
        process.env.WINDIR ?? 'C:\\Windows',
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      );
      const port = await availableLoopbackPort();
      const credential = `sk-claudedock-${'i'.repeat(43)}`;
      let child: ReturnType<typeof spawn> | undefined;
      let processId: number | undefined;

      try {
        writeFileSync(
          sourcePath,
          String.raw`using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
public static class GatewayFixture {
  public static void Main(string[] args) {
    int port = Int32.Parse(File.ReadAllText(args[1]));
    TcpListener listener = new TcpListener(IPAddress.Loopback, port);
    listener.Start();
    File.WriteAllText(args[1] + ".ready", "ready");
    using (TcpClient client = listener.AcceptTcpClient()) {
      NetworkStream stream = client.GetStream();
      stream.ReadTimeout = 15000;
      byte[] buffer = new byte[4096];
      StringBuilder request = new StringBuilder();
      while (request.ToString().IndexOf("\r\n\r\n", StringComparison.Ordinal) < 0 && request.Length <= 65536) {
        int count = stream.Read(buffer, 0, buffer.Length);
        if (count <= 0) break;
        request.Append(Encoding.ASCII.GetString(buffer, 0, count));
      }
      string requestText = request.ToString();
      bool authorized =
        requestText.StartsWith("GET /v1/models HTTP/1.1\r\n", StringComparison.Ordinal) &&
        requestText.IndexOf("\r\nAuthorization: Bearer sk-claudedock-", StringComparison.Ordinal) >= 0;
      File.WriteAllText(args[1] + ".request-result", authorized ? "authorized" : "rejected");
      string body = "{\"object\":\"list\",\"data\":[{\"id\":\"gpt-5.6-sol\",\"object\":\"model\",\"owned_by\":\"codex\"}]}";
      byte[] bodyBytes = Encoding.UTF8.GetBytes(body);
      string status = authorized ? "200 OK" : "401 Unauthorized";
      byte[] headers = Encoding.ASCII.GetBytes(
        "HTTP/1.1 " + status + "\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: " + bodyBytes.Length + "\r\n" +
        "Connection: close\r\n\r\n"
      );
      stream.Write(headers, 0, headers.Length);
      stream.Write(bodyBytes, 0, bodyBytes.Length);
      stream.Flush();
    }
    Thread.Sleep(300000);
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
        child = spawn(executablePath, ['-config', configPath], {
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', () => {});
        expect(child.pid).toBeTypeOf('number');
        processId = child.pid!;
        const processIdentity = new ManagedGatewayProcessIdentity();

        expect(await waitUntil(() => existsSync(readyPath), 5_000)).toBe(true);
        const identity = await processIdentity.capture(
          { configPath, executablePath, port, processId },
          5_000,
        );
        expect(identity).toEqual({
          startedAtTicks: expect.stringMatching(/^\d{10,20}$/),
          version: 1,
        });
        const reader = new ManagedGatewayOwnedModelReader({ processIdentity });

        expect(MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS).toBe(8_000);
        await expect(
          reader.read(
            { configPath, executablePath, identity: identity!, port, processId },
            credential,
            MANAGED_GATEWAY_READINESS_PROBE_TIMEOUT_MS,
          ),
        ).resolves.toEqual(['gpt-5.6-sol']);
        expect(await waitUntil(() => existsSync(requestResultPath), 1_000)).toBe(true);
        expect(readFileSync(requestResultPath, 'utf8')).toBe('authorized');
      } finally {
        if (child?.exitCode === null && processId !== undefined) {
          spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(processId)], {
            stdio: 'ignore',
            windowsHide: true,
          });
        }
        const launchedChild = child;
        if (launchedChild) await waitUntil(() => launchedChild.exitCode !== null, 3_000);
        rmSync(root, { force: true, recursive: true });
      }
    },
    30_000,
  );
});
