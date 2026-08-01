import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdvancedSettingsStore } from '../src/main/advanced-settings-store';

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

    expect(store.get()).toEqual({ webResearchIsolation: false });
  });

  it('persists a change for the next launch', () => {
    const { settingsPath, store } = createStore();

    expect(store.set({ webResearchIsolation: true })).toEqual({ webResearchIsolation: true });
    expect(store.get()).toEqual({ webResearchIsolation: true });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ version: 1 });
    expect(store.set({ webResearchIsolation: false })).toEqual({ webResearchIsolation: false });
  });

  it('rejects a value that is not a switch', () => {
    const { store } = createStore();

    expect(() => store.set({ webResearchIsolation: 'yes' as unknown as boolean })).toThrow(
      /高级设置/,
    );
  });

  it.each(['{ not json', '{"version":2,"webResearchIsolation":true}', '{"version":1}'])(
    'falls back to the defaults for unusable content %s',
    (content) => {
      const { settingsPath, store } = createStore();
      store.set({ webResearchIsolation: true });
      writeFileSync(settingsPath, content, 'utf8');

      expect(store.get()).toEqual({ webResearchIsolation: false });
    },
  );
});
