import { describe, expect, it, vi } from 'vitest';
import {
  parseWindowsProcessSnapshot,
  RuntimeProcessRegistry,
  type RuntimeProcessOwner,
  type RuntimeProcessSystem,
  type WindowsProcessSnapshot,
} from '../../src/main/runtime/process-registry';
import type { RuntimeWebProcessView } from '../../src/shared/contracts';

const owner: RuntimeProcessOwner = {
  launchGeneration: 3,
  ptyGeneration: 5,
  rootPid: 10,
  sessionId: 'session-1',
};

const snapshot = (startedAt = 2_000, rootStartedAt = 1_000): WindowsProcessSnapshot => ({
  listeners: [
    { address: '127.0.0.1', pid: 20, port: 3080 },
    { address: '0.0.0.0', pid: 30, port: 9222 },
    { address: '127.0.0.1', pid: 40, port: 4_000 },
  ],
  processes: [
    {
      commandLine: 'powershell',
      name: 'powershell.exe',
      parentPid: 1,
      pid: 10,
      startedAt: rootStartedAt,
    },
    {
      commandLine: 'node server.js --token secret',
      name: 'node.exe',
      parentPid: 10,
      pid: 20,
      startedAt,
    },
    {
      commandLine: 'chrome --remote-debugging-port=9222',
      name: 'chrome.exe',
      parentPid: 10,
      pid: 30,
      startedAt: 3_000,
    },
    {
      commandLine: 'node browser-helper.js',
      name: 'node.exe',
      parentPid: 30,
      pid: 40,
      startedAt: 3_100,
    },
  ],
});

describe('runtime process registry', () => {
  it('parses one-object PowerShell JSON shapes', () => {
    expect(
      parseWindowsProcessSnapshot(
        JSON.stringify({
          listeners: { address: '127.0.0.1', pid: 20, port: 3080 },
          processes: {
            commandLine: 'node app.js',
            name: 'node.exe',
            parentPid: 10,
            pid: 20,
            startedAt: 2_000,
          },
        }),
      ),
    ).toEqual({
      listeners: [{ address: '127.0.0.1', pid: 20, port: 3080 }],
      processes: [
        {
          commandLine: 'node app.js',
          name: 'node.exe',
          parentPid: 10,
          pid: 20,
          startedAt: 2_000,
        },
      ],
    });
  });

  it('shows only listening verified descendants, redacts commands, and changes keys on PID reuse', async () => {
    let current = snapshot();
    const published = new Map<string, RuntimeWebProcessView[]>();
    const system: RuntimeProcessSystem = {
      capture: vi.fn(async () => current),
      forceStop: vi.fn(async () => undefined),
      gracefulStop: vi.fn(async () => undefined),
    };
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      system,
    );
    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const first = published.get(owner.sessionId)?.[0];
    expect(first).toMatchObject({ name: 'node', pid: 20, ports: [3080] });
    expect(first?.commandSummary).not.toContain('secret');
    expect(first?.urls).toEqual([{ confirmed: false, url: 'http://127.0.0.1:3080' }]);
    expect(published.get(owner.sessionId)).toHaveLength(1);

    current = snapshot(4_000);
    await registry.scan();
    const reused = published.get(owner.sessionId)?.[0];
    expect(reused?.processKey).not.toBe(first?.processKey);

    current = snapshot(4_000, 5_000);
    await registry.scan();
    expect(published.get(owner.sessionId)?.[0]?.processKey).not.toBe(reused?.processKey);
  });

  it('revalidates the opaque key and ownership before stopping the exact subtree', async () => {
    let current = snapshot();
    const published = new Map<string, RuntimeWebProcessView[]>();
    const gracefulStop = vi.fn(async () => {
      current = { listeners: [], processes: current.processes.slice(0, 1) };
    });
    const forceStop = vi.fn(async () => undefined);
    const registry = new RuntimeProcessRegistry(
      (sessionId, processes) => published.set(sessionId, processes),
      { capture: vi.fn(async () => current), forceStop, gracefulStop },
    );
    registry.start(() => [owner]);
    await registry.scan();
    registry.stop();
    const processKey = published.get(owner.sessionId)?.[0]?.processKey ?? '';

    current = {
      listeners: [...current.listeners, { address: '127.0.0.1', pid: 60, port: 5_080 }],
      processes: [
        ...current.processes,
        {
          commandLine: 'claude.exe',
          name: 'claude.exe',
          parentPid: 20,
          pid: 50,
          startedAt: 5_000,
        },
        {
          commandLine: 'node claude-child.js',
          name: 'node.exe',
          parentPid: 50,
          pid: 60,
          startedAt: 6_000,
        },
      ],
    };

    await expect(registry.terminate(owner.sessionId, 'not-a-real-key')).rejects.toThrow(/不再属于/);
    await registry.terminate(owner.sessionId, processKey);
    expect(gracefulStop).toHaveBeenCalledWith([20]);
    expect(forceStop).not.toHaveBeenCalled();
    expect(published.get(owner.sessionId)).toEqual([]);
  });
});
