import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedGatewayPersistedProcess,
  ManagedGatewayProcessStopError,
} from '../../src/main/claude/managed-chatgpt-persisted-process';
import type { ManagedGatewayProcessIdentity } from '../../src/main/claude/managed-chatgpt-process-identity';
import type { ManagedGatewayProcessLifecycle } from '../../src/main/claude/managed-chatgpt-process-lifecycle';
import {
  ManagedGatewayStateStore,
  type ManagedGatewayStateFileSystem,
  type PersistedGatewayState,
} from '../../src/main/claude/managed-chatgpt-state';

const processOwnership = (
  processId: number,
  phase: 'ready' | 'starting' = 'ready',
): NonNullable<PersistedGatewayState['process']> => ({
  identity: { startedAtTicks: String(638900000000000000n + BigInt(processId)), version: 1 },
  phase,
  processId,
  version: 1,
});

const state = (processId = 42, phase: 'ready' | 'starting' = 'ready'): PersistedGatewayState => ({
  encryptedClientKey: 'encrypted-client-key',
  encryptedManagementKey: 'encrypted-management-key',
  executableRelativePath: path.join('versions', '7.2.117', 'cli-proxy-api.exe'),
  executableSha256: 'a'.repeat(64),
  installedVersion: '7.2.117',
  port: 8317,
  process: processOwnership(processId, phase),
  releaseDigest: 'b'.repeat(64),
  version: 1,
});

const safeStorage = {
  decryptString: vi.fn(),
  encryptString: vi.fn(),
  isEncryptionAvailable: vi.fn(() => true),
};

const createStore = (
  root: string,
  fileSystem?: ManagedGatewayStateFileSystem,
): ManagedGatewayStateStore =>
  new ManagedGatewayStateStore(
    root,
    path.join(root, 'state.json'),
    path.join(root, 'versions'),
    safeStorage,
    fileSystem,
  );

type MatchesMock = ReturnType<typeof vi.fn<ManagedGatewayProcessIdentity['matches']>>;
type PersistStateMock = ReturnType<typeof vi.fn<(next: PersistedGatewayState) => void>>;
type PortAvailableMock = ReturnType<
  typeof vi.fn<(port: number, timeoutMs?: number) => Promise<boolean>>
>;
type TerminateMock = ReturnType<typeof vi.fn<ManagedGatewayProcessIdentity['terminate']>>;

const createPersistedProcess = (
  initial: PersistedGatewayState,
  overrides: {
    matches?: MatchesMock;
    persistState?: PersistStateMock;
    portAvailable?: PortAvailableMock;
    terminate?: TerminateMock;
  } = {},
) => {
  let current = initial;
  const matches = overrides.matches ?? vi.fn(async () => 'match' as const);
  const terminate = overrides.terminate ?? vi.fn(async () => 'terminated' as const);
  const portAvailable = overrides.portAvailable ?? vi.fn(async () => true);
  const persistState =
    overrides.persistState ??
    vi.fn((next: PersistedGatewayState) => {
      current = next;
    });
  const complete = vi.fn();
  const currentOwnership = vi.fn(() => undefined);
  const processLifecycle = {
    complete,
    currentOwnership,
  } as unknown as ManagedGatewayProcessLifecycle;
  const persisted = new ManagedGatewayPersistedProcess({
    configPath: path.resolve('C:\\ClaudeDock\\config.yaml'),
    executablePath: () => path.resolve('C:\\ClaudeDock\\cli-proxy-api.exe'),
    loadState: () => current,
    persistState: (next) => {
      persistState(next);
      if (persistState.mock.results.at(-1)?.type !== 'throw') current = next;
    },
    portAvailable,
    processIdentity: { matches, terminate } as unknown as Pick<
      ManagedGatewayProcessIdentity,
      'matches' | 'terminate'
    >,
    processLifecycle,
  });
  return {
    complete,
    current: () => current,
    currentOwnership,
    matches,
    persisted,
    persistState,
    portAvailable,
    replace: (next: PersistedGatewayState) => {
      current = next;
    },
    terminate,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('managed gateway persisted state ownership', () => {
  it('sanitizes legacy PID-only state and never imports persisted model lists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-gateway-state-legacy-'));
    const persisted = state();
    const { process: _process, ...base } = persisted;
    void _process;
    writeFileSync(
      path.join(root, 'state.json'),
      JSON.stringify({
        ...base,
        availableModels: ['persisted-stale-model'],
        processId: 42,
        secretFilename: 'codex-user@example.com.json',
      }),
      'utf8',
    );

    try {
      const loaded = createStore(root).load();
      expect(loaded).toEqual(base);
      expect(loaded).not.toHaveProperty('process');
      expect(loaded).not.toHaveProperty('processId');
      expect(loaded).not.toHaveProperty('availableModels');
      expect(loaded).not.toHaveProperty('secretFilename');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('ignores malformed nested birth identity while preserving valid base installation state', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-gateway-state-malformed-'));
    const persisted = state();
    writeFileSync(
      path.join(root, 'state.json'),
      JSON.stringify({
        ...persisted,
        process: {
          ...persisted.process,
          identity: { startedAtTicks: '42', version: 1 },
        },
      }),
      'utf8',
    );

    try {
      expect(createStore(root).load()).toEqual({ ...persisted, process: undefined });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('recovers a complete starting record left by an atomic rename failure over an old PID record', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-gateway-state-rename-'));
    const statePath = path.join(root, 'state.json');
    const oldState = state(41);
    const starting = state(42, 'starting');
    writeFileSync(statePath, `${JSON.stringify(oldState)}\n`, 'utf8');
    const rename = vi.fn(() => {
      throw new Error('injected rename failure');
    });
    const fileSystem: ManagedGatewayStateFileSystem = {
      mkdir: mkdirSync,
      readFile: readFileSync,
      rename: rename as unknown as typeof renameSync,
      writeFile: writeFileSync,
    };
    const store = createStore(root, fileSystem);

    try {
      expect(() => store.persist(starting)).toThrow('injected rename failure');
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        process: { processId: 41 },
      });
      expect(JSON.parse(readFileSync(`${statePath}.tmp`, 'utf8'))).toMatchObject({
        process: { phase: 'starting', processId: 42 },
      });
      expect(store.load()).toEqual(starting);
      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('persists and promotes starting ownership only by exact compare-and-swap identity', () => {
    const initial = { ...state(), process: undefined };
    const fixture = createPersistedProcess(initial);
    const starting = fixture.persisted.persistStarting(
      initial,
      42,
      processOwnership(42, 'starting').identity,
    );

    expect(fixture.current()).toEqual(starting);
    const ready = fixture.persisted.promoteReady(starting, undefined);
    expect(ready.process).toMatchObject({ phase: 'ready', processId: 42 });
    expect(fixture.current()).toEqual(ready);

    fixture.replace({ ...ready, process: processOwnership(43, 'starting') });
    expect(() => fixture.persisted.promoteReady(starting, undefined)).toThrow('其他代次替换');
    expect(fixture.current().process?.processId).toBe(43);
  });

  it.each(['absent', 'mismatch'] as const)(
    'treats an %s process as non-owned and clears stale state without throwing',
    async (status) => {
      const fixture = createPersistedProcess(state(), {
        matches: vi.fn(async () => status),
      });

      await expect(fixture.persisted.ownedProcessId(fixture.current())).resolves.toBeUndefined();
      expect(fixture.current().process).toBeUndefined();
      expect(fixture.terminate).not.toHaveBeenCalled();
    },
  );

  it('retains exact ownership when a concurrent inspection times out instead of erasing a live gateway', async () => {
    const fixture = createPersistedProcess(state(42, 'starting'), {
      matches: vi.fn(async () => 'inaccessible' as const),
    });
    const starting = fixture.current();
    await expect(fixture.persisted.ownedProcessId(starting)).resolves.toBeUndefined();
    expect(fixture.current()).toEqual(starting);
    expect(fixture.persistState).not.toHaveBeenCalled();
    expect(fixture.terminate).not.toHaveBeenCalled();
    fixture.matches.mockResolvedValue('match');
    await expect(fixture.persisted.ownedProcessId(starting)).resolves.toBe(42);
  });

  it('does not poison normal ownership reads when stale-record cleanup cannot be committed', async () => {
    const persistState = vi.fn(() => {
      throw new Error('injected state write failure');
    });
    const fixture = createPersistedProcess(state(), {
      matches: vi.fn(async () => 'mismatch' as const),
      persistState,
    });

    await expect(fixture.persisted.ownedProcessId(fixture.current())).resolves.toBeUndefined();
    expect(fixture.current().process?.processId).toBe(42);
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it('never kills a mismatched PID and conditionally clears only its stale record', async () => {
    const fixture = createPersistedProcess(state(), {
      terminate: vi.fn(async () => 'mismatch' as const),
    });

    await expect(fixture.persisted.stop(fixture.current(), 'occupied')).resolves.toBe(true);
    expect(fixture.terminate).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: processOwnership(42).identity,
        processId: 42,
      }),
      expect.any(Number),
    );
    expect(fixture.portAvailable).not.toHaveBeenCalled();
    expect(fixture.current().process).toBeUndefined();
  });

  it.each(['inaccessible', 'timeout'] as const)(
    'preserves exact residual ownership after a %s termination result',
    async (result) => {
      const fixture = createPersistedProcess(state(), {
        terminate: vi.fn(async () => result),
      });

      await expect(fixture.persisted.stop(fixture.current(), 'occupied')).rejects.toBeInstanceOf(
        ManagedGatewayProcessStopError,
      );
      expect(fixture.current().process?.processId).toBe(42);
      expect(fixture.portAvailable).not.toHaveBeenCalled();
    },
  );

  it('bounds a never-settling injected port probe inside the total stop budget', async () => {
    vi.useFakeTimers();
    const fixture = createPersistedProcess(state(), {
      portAvailable: vi.fn(() => new Promise<boolean>(() => {})),
    });

    const stopped = fixture.persisted.stop(fixture.current(), 'port still occupied');
    const rejection = expect(stopped).rejects.toThrow('port still occupied');
    await vi.advanceTimersByTimeAsync(2_100);
    await rejection;
    expect(fixture.portAvailable).toHaveBeenCalledWith(8317, expect.any(Number));
    expect(fixture.current().process?.processId).toBe(42);
  });

  it('does not clear a replacement record published during the final port probe', async () => {
    const fixture = createPersistedProcess(state());
    const replacement = state(43, 'starting');
    fixture.portAvailable.mockImplementation(async () => {
      fixture.replace(replacement);
      return true;
    });

    await expect(fixture.persisted.stop(state(), 'occupied')).resolves.toBe(true);
    expect(fixture.current()).toEqual(replacement);
  });

  it('retains exact ownership evidence when the post-exit state clear cannot be committed', async () => {
    const persistState = vi.fn(() => {
      throw new Error('injected clear failure');
    });
    const fixture = createPersistedProcess(state(), { persistState });

    await expect(fixture.persisted.stop(fixture.current(), 'occupied')).rejects.toThrow(
      'injected clear failure',
    );
    expect(fixture.current().process?.processId).toBe(42);
  });
});
