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
    expect(store.get()).toEqual({
      claudeContextWindowMode: 'auto',
      closeBehavior: 'tray',
      closeToTrayNoticeShown: false,
      footerResourcePreference: 'auto',
      managedChatGptContextWindowMode: 'standard',
    });
    store.set({ closeToTrayNoticeShown: true });
    expect(store.get()).toEqual({
      claudeContextWindowMode: 'auto',
      closeBehavior: 'tray',
      closeToTrayNoticeShown: true,
      footerResourcePreference: 'auto',
      managedChatGptContextWindowMode: 'standard',
    });
  });

  it('persists direct exit without changing the notice flag', () => {
    const store = createStore();
    expect(store.set({ closeBehavior: 'exit' })).toEqual({
      claudeContextWindowMode: 'auto',
      closeBehavior: 'exit',
      closeToTrayNoticeShown: false,
      footerResourcePreference: 'auto',
      managedChatGptContextWindowMode: 'standard',
    });
    expect(store.get().closeBehavior).toBe('exit');
  });

  it('persists the explicit extended managed ChatGPT context choice', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
    fixtureRoots.push(directory);
    const store = new AppPreferencesStore(directory);
    expect(store.set({ managedChatGptContextWindowMode: 'extended' })).toMatchObject({
      managedChatGptContextWindowMode: 'extended',
    });
    expect(new AppPreferencesStore(directory).get().managedChatGptContextWindowMode).toBe(
      'extended',
    );
  });

  it.each([8_000, 2_000_000])('persists the custom Claude context boundary %i', (tokens) => {
    const store = createStore();
    expect(
      store.set({
        claudeContextWindowCustomTokens: tokens,
        claudeContextWindowMode: 'custom',
      }),
    ).toMatchObject({
      claudeContextWindowCustomTokens: tokens,
      claudeContextWindowMode: 'custom',
    });
  });

  it.each([7_999, 2_000_001, 200_000.5])(
    'rejects the invalid custom Claude context window %i',
    (tokens) => {
      const store = createStore();
      expect(() =>
        store.set({
          claudeContextWindowCustomTokens: tokens,
          claudeContextWindowMode: 'custom',
        }),
      ).toThrow('应用偏好设置无效');
    },
  );
});
