import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_EXECUTION_SETTINGS_MAX_BYTES,
  ClaudeExecutionSettingsNewerVersionError,
  ClaudeExecutionSettingsStore,
  ClaudeExecutionSettingsWriteBlockedError,
  replaceExecutionSettingsFileAtomically,
} from '../../src/main/claude/execution-settings-store';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-execution-settings-'));
  fixtureRoots.push(fixtureRoot);
  return {
    settingsPath: path.join(fixtureRoot, 'claude', 'execution-settings.json'),
    store: new ClaudeExecutionSettingsStore(fixtureRoot),
  };
};

const fileSystemError = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

describe('independent Claude execution settings store', () => {
  it('defaults to Claude-owned behavior without creating a file', () => {
    const { settingsPath, store } = createStore();

    expect(store.get()).toEqual({
      catalogVersion: 1,
      requested: { mode: 'claude-default' },
      version: 1,
    });
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('persists only the requested profile and catalogue/schema versions', async () => {
    const { settingsPath, store } = createStore();

    await store.set({ mode: 'profile', profileId: 'balanced' });

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      catalogVersion: 1,
      requested: { mode: 'profile', profileId: 'balanced' },
      version: 1,
    });
    const serialized = readFileSync(settingsPath, 'utf8');
    for (const forbidden of [
      'effective',
      'environment',
      'installedVersion',
      'endpoint',
      'credential',
      'secret',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('persists a strict custom request and reloads it independently', async () => {
    const { settingsPath, store } = createStore();
    const requested = {
      mode: 'custom',
      values: {
        concurrentSubagents: 7,
        spawnDepth: 2,
        toolSearch: 'auto:0',
        toolUseConcurrency: 9,
      },
    } as const;

    expect((await store.set(requested)).requested).toEqual(requested);
    expect(
      new ClaudeExecutionSettingsStore(path.dirname(path.dirname(settingsPath))).get().requested,
    ).toEqual(requested);
  });

  it.each([
    '{ not json',
    '{"version":2,"catalogVersion":1,"requested":{"mode":"profile","profileId":"balanced"}}',
    '{"version":1,"catalogVersion":2,"requested":{"mode":"profile","profileId":"balanced"}}',
    '{"version":1,"catalogVersion":1,"requested":{"mode":"profile","profileId":"invented"}}',
    '{"version":1,"catalogVersion":1,"requested":{"mode":"claude-default"},"token":"secret"}',
  ])('falls back to defaults for malformed, unsupported, or non-strict content %s', (content) => {
    const { settingsPath, store } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, content, 'utf8');

    expect(store.get().requested).toEqual({ mode: 'claude-default' });
  });

  it('preserves a future-schema snapshot byte-for-byte when update is attempted', async () => {
    const { settingsPath, store } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original =
      '{\r\n  "version": 2,\r\n  "catalogVersion": 1,\r\n  "requested": { "mode": "future-mode" },\r\n  "futureField": [1, 2, 3]\r\n}\r\n';
    writeFileSync(settingsPath, original, 'utf8');

    let failure: unknown;
    try {
      await store.set({ mode: 'profile', profileId: 'balanced' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ClaudeExecutionSettingsNewerVersionError);
    expect(failure).toMatchObject({
      code: 'CLAUDE_EXECUTION_SETTINGS_NEWER_VERSION',
      declaredCatalogVersion: 1,
      declaredSchemaVersion: 2,
    });
    expect((failure as Error).message).toContain('升级 ClaudeDock');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('preserves a future-catalog snapshot byte-for-byte when reset is attempted', async () => {
    const { settingsPath, store } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original =
      '{\n  "catalogVersion": 2,\n  "requested": { "mode": "profile", "profileId": "next-profile" },\n  "version": 1\n}\n';
    writeFileSync(settingsPath, original, 'utf8');

    let failure: unknown;
    try {
      await store.reset();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ClaudeExecutionSettingsNewerVersionError);
    expect(failure).toMatchObject({
      code: 'CLAUDE_EXECUTION_SETTINGS_NEWER_VERSION',
      declaredCatalogVersion: 2,
      declaredSchemaVersion: 1,
    });
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('preserves an oversized future-schema file when update is attempted', async () => {
    const { settingsPath, store } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(
      {
        catalogVersion: 1,
        futurePayload: 'x'.repeat(CLAUDE_EXECUTION_SETTINGS_MAX_BYTES),
        requested: { mode: 'future-mode' },
        version: 2,
      },
      null,
      2,
    )}\r\n`;
    expect(Buffer.byteLength(original, 'utf8')).toBeGreaterThan(
      CLAUDE_EXECUTION_SETTINGS_MAX_BYTES,
    );
    writeFileSync(settingsPath, original, 'utf8');

    let failure: unknown;
    try {
      await store.set({ mode: 'profile', profileId: 'balanced' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ClaudeExecutionSettingsWriteBlockedError);
    expect(failure).toMatchObject({
      code: 'CLAUDE_EXECUTION_SETTINGS_WRITE_BLOCKED',
      reason: 'unreadable',
    });
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('preserves an oversized future-catalog file when reset is attempted', async () => {
    const { settingsPath, store } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify({
      catalogVersion: 2,
      futurePayload: 'y'.repeat(CLAUDE_EXECUTION_SETTINGS_MAX_BYTES),
      requested: { mode: 'next-profile' },
      version: 1,
    })}\n`;
    expect(Buffer.byteLength(original, 'utf8')).toBeGreaterThan(
      CLAUDE_EXECUTION_SETTINGS_MAX_BYTES,
    );
    writeFileSync(settingsPath, original, 'utf8');

    let failure: unknown;
    try {
      await store.reset();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ClaudeExecutionSettingsWriteBlockedError);
    expect(failure).toMatchObject({
      code: 'CLAUDE_EXECUTION_SETTINGS_WRITE_BLOCKED',
      reason: 'unreadable',
    });
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('bounds file reads and rejects invalid or secret-bearing custom payloads', async () => {
    const { settingsPath, store } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, ' '.repeat(CLAUDE_EXECUTION_SETTINGS_MAX_BYTES + 1), 'utf8');
    expect(store.get().requested).toEqual({ mode: 'claude-default' });

    await expect(
      store.set({
        mode: 'custom',
        values: {
          concurrentSubagents: 2,
          spawnDepth: 0,
          toolSearch: 'inherit',
          toolUseConcurrency: 4,
        },
      }),
    ).rejects.toThrow(/无效/);
    await expect(
      store.set({
        mode: 'custom',
        values: {
          concurrentSubagents: 2,
          spawnDepth: 1,
          toolSearch: 'auto:101',
          toolUseConcurrency: 4,
          ANTHROPIC_AUTH_TOKEN: 'must-not-persist',
        },
      } as never),
    ).rejects.toThrow(/无效/);
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('must-not-persist');
  });

  it('reset writes an explicit Claude-default request without runtime-derived fields', async () => {
    const { settingsPath, store } = createStore();
    await store.set({ mode: 'profile', profileId: 'best-performance' });

    expect(await store.reset()).toEqual({
      catalogVersion: 1,
      requested: { mode: 'claude-default' },
      version: 1,
    });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      catalogVersion: 1,
      requested: { mode: 'claude-default' },
      version: 1,
    });
  });
});

describe('execution settings atomic replacement', () => {
  it('uses unique same-directory paths and flushes exclusive private files before rename', async () => {
    const target = 'C:\\profile\\claude\\execution-settings.json';
    const ids = ['first', 'second'];
    const descriptors = [41, 42];
    const closeFile = vi.fn();
    const createTemporaryId = vi.fn(() => ids.shift() ?? 'unexpected');
    const flushFile = vi.fn();
    const openFile = vi.fn(() => descriptors.shift() ?? -1);
    const renameFile = vi.fn();
    const writeFile = vi.fn();
    const operations = {
      closeFile,
      createTemporaryId,
      flushFile,
      openFile,
      renameFile,
      writeFile,
    };

    await replaceExecutionSettingsFileAtomically(target, 'one', operations);
    await replaceExecutionSettingsFileAtomically(target, 'two', operations);

    expect(openFile).toHaveBeenNthCalledWith(1, `${target}.tmp-${process.pid}-first`, 'wx', 0o600);
    expect(openFile).toHaveBeenNthCalledWith(2, `${target}.tmp-${process.pid}-second`, 'wx', 0o600);
    expect(writeFile.mock.calls).toEqual([
      [41, 'one'],
      [42, 'two'],
    ]);
    expect(flushFile.mock.calls).toEqual([[41], [42]]);
    expect(closeFile.mock.calls).toEqual([[41], [42]]);
    expect(renameFile).toHaveBeenNthCalledWith(1, `${target}.tmp-${process.pid}-first`, target);
    expect(renameFile).toHaveBeenNthCalledWith(2, `${target}.tmp-${process.pid}-second`, target);
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      flushFile.mock.invocationCallOrder[0]!,
    );
    expect(flushFile.mock.invocationCallOrder[0]).toBeLessThan(
      closeFile.mock.invocationCallOrder[0]!,
    );
    expect(closeFile.mock.invocationCallOrder[0]).toBeLessThan(
      renameFile.mock.invocationCallOrder[0]!,
    );
  });

  it('preserves the destination when an injected flush fails', async () => {
    const { settingsPath } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, 'last-valid', 'utf8');
    const temporaryPath = `${settingsPath}.tmp-${process.pid}-flush-failure`;
    const flushError = new Error('flush failed');
    const closeFile = vi.fn();
    const renameFile = vi.fn();
    const unlinkFile = vi.fn();

    await expect(
      replaceExecutionSettingsFileAtomically(settingsPath, 'replacement', {
        closeFile,
        createTemporaryId: () => 'flush-failure',
        flushFile: () => {
          throw flushError;
        },
        openFile: () => 51,
        renameFile,
        unlinkFile,
        writeFile: vi.fn(),
      }),
    ).rejects.toThrow(flushError);
    expect(closeFile).toHaveBeenCalledOnce();
    expect(renameFile).not.toHaveBeenCalled();
    expect(unlinkFile).toHaveBeenCalledWith(temporaryPath);
    expect(readFileSync(settingsPath, 'utf8')).toBe('last-valid');
  });

  it('preserves the destination when an injected close fails', async () => {
    const { settingsPath } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, 'last-valid', 'utf8');
    const temporaryPath = `${settingsPath}.tmp-${process.pid}-close-failure`;
    const closeError = new Error('close failed');
    const closeFile = vi.fn(() => {
      throw closeError;
    });
    const renameFile = vi.fn();
    const unlinkFile = vi.fn();

    await expect(
      replaceExecutionSettingsFileAtomically(settingsPath, 'replacement', {
        closeFile,
        createTemporaryId: () => 'close-failure',
        flushFile: vi.fn(),
        openFile: () => 52,
        renameFile,
        unlinkFile,
        writeFile: vi.fn(),
      }),
    ).rejects.toThrow(closeError);
    expect(closeFile).toHaveBeenCalledTimes(2);
    expect(renameFile).not.toHaveBeenCalled();
    expect(unlinkFile).toHaveBeenCalledWith(temporaryPath);
    expect(readFileSync(settingsPath, 'utf8')).toBe('last-valid');
  });

  it('awaits retry backoff asynchronously before a later rename attempt', async () => {
    let releaseDelay!: () => void;
    const delay = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const renameFile = vi.fn(() => {
      if (renameFile.mock.calls.length === 1) {
        throw fileSystemError('EBUSY');
      }
    });
    const sleep = vi.fn(() => delay);

    const pending = replaceExecutionSettingsFileAtomically('C:\\profile\\execution.json', 'next', {
      closeFile: vi.fn(),
      createTemporaryId: () => 'async-retry',
      flushFile: vi.fn(),
      openFile: () => 61,
      renameFile,
      sleep,
      writeFile: vi.fn(),
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(renameFile).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5);
    expect(settled).toBe(false);

    releaseDelay();
    await pending;
    expect(renameFile).toHaveBeenCalledTimes(2);
    expect(settled).toBe(true);
  });

  it('retries bounded transient Windows rename errors and cleans its temporary file on failure', async () => {
    const { settingsPath } = createStore();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, 'last-valid', 'utf8');
    const temporaryPath = `${settingsPath}.tmp-${process.pid}-locked`;
    const renameError = fileSystemError('EACCES', 'locked');
    const renameFile = vi.fn(() => {
      throw renameError;
    });
    const sleep = vi.fn();

    await expect(
      replaceExecutionSettingsFileAtomically(settingsPath, 'replacement', {
        createTemporaryId: () => 'locked',
        renameFile,
        sleep,
      }),
    ).rejects.toThrow(renameError);
    expect(renameFile).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls).toEqual([[5], [10], [20], [40], [80]]);
    expect(readFileSync(settingsPath, 'utf8')).toBe('last-valid');
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it('never deletes an exclusive-create collision it did not own', async () => {
    const unlinkFile = vi.fn();
    await expect(
      replaceExecutionSettingsFileAtomically('C:\\profile\\execution-settings.json', 'next', {
        createTemporaryId: () => 'collision',
        openFile: () => {
          throw fileSystemError('EEXIST');
        },
        unlinkFile,
      }),
    ).rejects.toThrow();
    expect(unlinkFile).not.toHaveBeenCalled();
  });
});
