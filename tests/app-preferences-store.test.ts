import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppPreferencesStore } from '../src/main/app-preferences-store';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = (): AppPreferencesStore => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
  fixtureRoots.push(root);
  return new AppPreferencesStore(root);
};

describe('app preferences store', () => {
  it('defaults to tray and persists the one-time notice', () => {
    const store = createStore();
    expect(store.get()).toEqual({ closeBehavior: 'tray', closeToTrayNoticeShown: false });
    store.set({ closeToTrayNoticeShown: true });
    expect(store.get()).toEqual({ closeBehavior: 'tray', closeToTrayNoticeShown: true });
  });

  it('persists direct exit without changing the notice flag', () => {
    const store = createStore();
    expect(store.set({ closeBehavior: 'exit' })).toEqual({
      closeBehavior: 'exit',
      closeToTrayNoticeShown: false,
    });
    expect(store.get().closeBehavior).toBe('exit');
  });
});
