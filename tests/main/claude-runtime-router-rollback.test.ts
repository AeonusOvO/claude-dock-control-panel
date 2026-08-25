import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedRouterProvider } from '../../src/main/claude/router-manager';
import type { ClaudeConnectionHistoryAuthorization } from '../../src/main/claude/runtime-connection-config';
import { ClaudeRuntime } from '../../src/main/claude/runtime';
import type { PreparedClaudeConfigSave } from '../../src/main/claude/runtime-types';
import type { SaveClaudeConfigInput } from '../../src/shared/contracts';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const input: SaveClaudeConfigInput = {
  authMode: 'authToken',
  baseUrl: 'https://relay.example.com/v1',
  credential: 'sk-upstream-example',
  credentialAction: 'replace',
  model: 'deepseek-chat',
  preset: 'custom',
  protocol: 'openai',
  provider: 'gateway',
};

const createRuntime = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-router-rollback-'));
  temporaryRoots.push(root);
  return new ClaudeRuntime(
    root,
    path.join(root, 'statusline.ps1'),
    path.join(root, 'signal.ps1'),
    path.join(root, 'guard.ps1'),
    () => false,
    () => 'standard',
    () => ({ mode: 'auto' }),
    () => undefined,
    () => true,
    async () => undefined,
    async () => undefined,
    () => undefined,
  );
};

const routerState = {
  canUninstall: true,
  checkedAt: 1,
  endpoint: 'http://127.0.0.1:3456',
  gatewayState: 'running',
  installed: true,
  installationKind: 'npm',
  manageable: true,
  managementAvailable: true,
  message: '模型网关已运行。',
  providers: [],
  serviceRunning: true,
  version: '3.1.0',
} as const;

const savedProvider = (rollbackConfigMutation: () => Promise<void>): SavedRouterProvider => ({
  connection: {
    apiKey: 'sk-local-gateway',
    baseUrl: 'http://127.0.0.1:3456',
    model: 'relay-example/deepseek-chat',
  },
  provider: {
    baseUrl: input.baseUrl,
    credentialConfigured: true,
    id: 'relay-example',
    models: ['deepseek-chat'],
    name: 'relay-example',
    preferred: true,
    protocol: 'openai_chat_completions',
  },
  rollbackConfigMutation,
  state: {
    ...routerState,
    providers: [],
  },
});

describe('Claude runtime Router preparation rollback', () => {
  it('rolls back when cancellation lands immediately after the Router save', async () => {
    const runtime = createRuntime();
    const rollback = vi.fn(async () => undefined);
    const routerManager = {
      getState: vi.fn(async () => routerState),
      saveProvider: vi.fn(async () => savedProvider(rollback)),
      start: vi.fn(async () => routerState),
    };
    (runtime as unknown as { routerManager: typeof routerManager }).routerManager = routerManager;
    let assertions = 0;

    await expect(
      runtime.prepareConnectionConfig(input, undefined, () => {
        assertions += 1;
        if (assertions === 2) throw new Error('history apply cancelled');
      }),
    ).rejects.toThrow('history apply cancelled');

    expect(routerManager.saveProvider).toHaveBeenCalledOnce();
    expect(routerManager.start).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back when route startup fails after the Router save', async () => {
    const runtime = createRuntime();
    const rollback = vi.fn(async () => undefined);
    const startFailure = new Error('gateway restart failed');
    const routerManager = {
      getState: vi.fn(async () => routerState),
      saveProvider: vi.fn(async () => savedProvider(rollback)),
      start: vi.fn(async () => {
        throw startFailure;
      }),
    };
    (runtime as unknown as { routerManager: typeof routerManager }).routerManager = routerManager;

    await expect(runtime.prepareConnectionConfig(input)).rejects.toBe(startFailure);

    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back when cancellation lands at the final prepared-config handoff', async () => {
    const runtime = createRuntime();
    const rollback = vi.fn(async () => undefined);
    const routerManager = {
      getState: vi.fn(async () => routerState),
      saveProvider: vi.fn(async () => savedProvider(rollback)),
      start: vi.fn(async () => routerState),
    };
    (runtime as unknown as { routerManager: typeof routerManager }).routerManager = routerManager;
    let assertions = 0;

    await expect(
      runtime.prepareConnectionConfig(input, undefined, () => {
        assertions += 1;
        if (assertions === 4) throw new Error('cancelled at prepared handoff');
      }),
    ).rejects.toThrow('cancelled at prepared handoff');

    expect(routerManager.start).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back when an authorized-history post-prepare check becomes stale', async () => {
    const runtime = createRuntime();
    const rollback = vi.fn(async () => undefined);
    const prepared: PreparedClaudeConfigSave = {
      input,
      rollbackRouterConfig: rollback,
    };
    const failure = new Error('history authorization changed after prepare');
    vi.spyOn(runtime, 'assertConnectionHistoryAuthorizationCurrent')
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw failure;
      });
    (
      runtime as unknown as {
        prepareConnectionReplay: () => Promise<PreparedClaudeConfigSave>;
      }
    ).prepareConnectionReplay = vi.fn(async () => prepared);
    const authorization: ClaudeConnectionHistoryAuthorization = {
      cwdKey: 'd:\\project',
      entryId: 'history-entry',
      replay: { config: input, protocol: 'openai' },
    };

    await expect(
      runtime.prepareAuthorizedConnectionHistory('D:\\Project', authorization),
    ).rejects.toBe(failure);
    expect(rollback).toHaveBeenCalledOnce();
  });
});
