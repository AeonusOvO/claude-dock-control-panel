import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePermissionBridge } from '../../src/main/claude/permission-bridge';
import type { ClaudePermissionRequestView } from '../../src/shared/contracts';

const bridges: ClaudePermissionBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.shutdown();
});

const connect = (pipeName: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

const readLine = (socket: Socket): Promise<string> =>
  new Promise((resolve) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    socket.on('end', () => resolve(buffer));
  });

describe.runIf(process.platform === 'win32')('Claude permission named-pipe bridge', () => {
  it('queues a typed request and returns only the selected official hook decision', async () => {
    let resolveRequest: ((request: ClaudePermissionRequestView) => void) | undefined;
    const received = new Promise<ClaudePermissionRequestView>((resolve) => {
      resolveRequest = resolve;
    });
    const bridge = new ClaudePermissionBridge(
      (request) => resolveRequest?.(request),
      () => true,
    );
    bridges.push(bridge);
    const endpoint = bridge.createEndpoint('session-1', 8);
    const socket = await connect(endpoint.pipeName);
    socket.write(
      `${JSON.stringify({
        launchGeneration: 8,
        sessionId: 'session-1',
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
        token: endpoint.token,
        toolName: 'Bash',
      })}\n`,
    );
    const request = await received;
    expect(request).toMatchObject({ sessionId: 'session-1', toolName: 'Bash' });
    expect(request.description).not.toContain('rules');
    expect(bridge.respond(request.requestId, { behavior: 'allow' })).toBe(true);
    const response = JSON.parse(await readLine(socket)) as {
      hookSpecificOutput: { decision: { behavior: string; updatedPermissions?: unknown } };
    };
    expect(response.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it('falls back to Claude native interaction for invalid generations and explicit fallback', async () => {
    const onRequest = vi.fn();
    let ownsLaunch = true;
    const bridge = new ClaudePermissionBridge(onRequest, () => ownsLaunch);
    bridges.push(bridge);
    const endpoint = bridge.createEndpoint('session-2', 9);
    const socket = await connect(endpoint.pipeName);
    socket.write(
      `${JSON.stringify({
        launchGeneration: 9,
        sessionId: 'session-2',
        token: endpoint.token,
        toolName: 'Write',
      })}\n`,
    );
    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledOnce());
    const request = onRequest.mock.calls[0]?.[0] as ClaudePermissionRequestView;
    ownsLaunch = false;
    expect(bridge.respond(request.requestId, { behavior: 'allow' })).toBe(true);
    expect(await readLine(socket)).toBe('');
  });

  it('dispatches the next request as soon as a hook client closes its pipe normally', async () => {
    const onRequest = vi.fn();
    const bridge = new ClaudePermissionBridge(onRequest, () => true);
    bridges.push(bridge);
    const endpoint = bridge.createEndpoint('session-3', 3);

    const first = await connect(endpoint.pipeName);
    first.write(
      `${JSON.stringify({
        launchGeneration: 3,
        sessionId: 'session-3',
        token: endpoint.token,
        toolName: 'Bash',
      })}\n`,
    );
    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledOnce());

    // The hook gave up on its own — Claude Code exited, or its 600s wait elapsed — and closed the
    // pipe cleanly. A normal close emits no 'error', so nothing released the active slot and every
    // later request sat in the queue until the ten-minute timeout.
    first.end();

    const second = await connect(endpoint.pipeName);
    second.write(
      `${JSON.stringify({
        launchGeneration: 3,
        sessionId: 'session-3',
        token: endpoint.token,
        toolName: 'Write',
      })}\n`,
    );

    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2));
    expect(onRequest.mock.calls[1]?.[0]).toMatchObject({ toolName: 'Write' });
  });
});
