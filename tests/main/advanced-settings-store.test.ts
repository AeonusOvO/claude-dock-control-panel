import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdvancedSettingsStore } from '../../src/main/stores/advanced-settings';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-advanced-'));
  fixtureRoots.push(fixtureRoot);
  return {
    settingsPath: path.join(fixtureRoot, 'advanced', 'settings.json'),
    store: new AdvancedSettingsStore(fixtureRoot),
  };
};

describe('AdvancedSettingsStore', () => {
  /*
   * These switches exist to work around relay defects. A user who never opens the tab must get a
   * plain Claude Code session, so the default has to stay off.
   */
  it('leaves every workaround off until it is turned on', () => {
    const { store } = createStore();

    expect(store.get()).toEqual({ chatIdleTimeoutMinutes: 0, webResearchIsolation: false });
  });

  it('persists a change for the next launch', () => {
    const { settingsPath, store } = createStore();

    expect(store.set({ chatIdleTimeoutMinutes: 10, webResearchIsolation: true })).toEqual({
      chatIdleTimeoutMinutes: 10,
      webResearchIsolation: true,
    });
    expect(store.get()).toEqual({ chatIdleTimeoutMinutes: 10, webResearchIsolation: true });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ version: 1 });
    expect(store.set({ chatIdleTimeoutMinutes: 0, webResearchIsolation: false })).toEqual({
      chatIdleTimeoutMinutes: 0,
      webResearchIsolation: false,
    });
  });

  it('rejects a value that is not a switch', () => {
    const { store } = createStore();

    expect(() =>
      store.set({
        chatIdleTimeoutMinutes: 0,
        webResearchIsolation: 'yes' as unknown as boolean,
      }),
    ).toThrow(/高级设置/);
    expect(() =>
      store.set({ chatIdleTimeoutMinutes: 15 as 0, webResearchIsolation: false }),
    ).toThrow(/高级设置/);
  });

  it.each(['{ not json', '{"version":2,"webResearchIsolation":true}', '{"version":1}'])(
    'falls back to the defaults for unusable content %s',
    (content) => {
      const { settingsPath, store } = createStore();
      store.set({ chatIdleTimeoutMinutes: 30, webResearchIsolation: true });
      writeFileSync(settingsPath, content, 'utf8');

      expect(store.get()).toEqual({ chatIdleTimeoutMinutes: 0, webResearchIsolation: false });
    },
  );

  it('migrates an existing version 1 switch file to no automatic timeout', () => {
    const { settingsPath, store } = createStore();
    store.set({ chatIdleTimeoutMinutes: 5, webResearchIsolation: false });
    writeFileSync(settingsPath, '{"version":1,"webResearchIsolation":true}', 'utf8');

    expect(store.get()).toEqual({ chatIdleTimeoutMinutes: 0, webResearchIsolation: true });
  });
});
