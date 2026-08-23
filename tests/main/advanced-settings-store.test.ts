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

const settings = (chatIdleTimeoutMinutes: 0 | 5 | 10 | 30, webResearchIsolation: boolean) => ({
  chatIdleTimeoutMinutes,
  networkPreflight: { checkOnNewSession: true, checkOnProviderLogin: true },
  webResearchIsolation,
});

describe('AdvancedSettingsStore', () => {
  /*
   * These switches exist to work around relay defects. A user who never opens the tab must get a
   * plain Claude Code session, so the default has to stay off.
   */
  it('leaves every workaround off until it is turned on', () => {
    const { store } = createStore();

    expect(store.get()).toEqual(settings(0, false));
  });

  it('persists a change for the next launch', () => {
    const { settingsPath, store } = createStore();

    expect(store.set(settings(10, true))).toEqual(settings(10, true));
    expect(store.get()).toEqual(settings(10, true));
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ version: 2 });
    expect(store.set(settings(0, false))).toEqual(settings(0, false));
  });

  it('rejects a value that is not a switch', () => {
    const { store } = createStore();

    expect(() =>
      store.set({
        chatIdleTimeoutMinutes: 0,
        networkPreflight: { checkOnNewSession: true, checkOnProviderLogin: true },
        webResearchIsolation: 'yes' as unknown as boolean,
      }),
    ).toThrow(/高级设置/);
    expect(() => store.set({ ...settings(0, false), chatIdleTimeoutMinutes: 15 as 0 })).toThrow(
      /高级设置/,
    );
  });

  it.each(['{ not json', '{"version":1}'])(
    'falls back to the defaults for unusable content %s',
    (content) => {
      const { settingsPath, store } = createStore();
      store.set(settings(30, true));
      writeFileSync(settingsPath, content, 'utf8');

      expect(store.get()).toEqual(settings(0, false));
    },
  );

  it('migrates an existing version 1 switch file to no automatic timeout', () => {
    const { settingsPath, store } = createStore();
    store.set(settings(5, false));
    writeFileSync(settingsPath, '{"version":1,"webResearchIsolation":true}', 'utf8');

    expect(store.get()).toEqual(settings(0, true));
  });
});
