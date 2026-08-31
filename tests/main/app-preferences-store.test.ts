import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppPreferencesStore } from '../../src/main/stores/app-preferences';

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
      modelUsageFloatingVisible: false,
      conversationResume: {
        autoLoadLastConversationModelOnStartup: true,
        autoLoadLastConversationOnStartup: true,
        modelMismatchBehavior: 'ask',
        startupModelConnectCancelAfterMinutes: 2,
        startupModelConnectForceStopAfterMinutes: 5,
      },
      footerResourcePreference: 'auto',
      managedChatGptContextWindowMode: 'standard',
    });
    store.set({ closeToTrayNoticeShown: true });
    expect(store.get()).toEqual({
      claudeContextWindowCustomTokens: undefined,
      claudeContextWindowMode: 'auto',
      closeBehavior: 'tray',
      closeToTrayNoticeShown: true,
      modelUsageFloatingVisible: false,
      conversationResume: {
        autoLoadLastConversationModelOnStartup: true,
        autoLoadLastConversationOnStartup: true,
        modelMismatchBehavior: 'ask',
        startupModelConnectCancelAfterMinutes: 2,
        startupModelConnectForceStopAfterMinutes: 5,
      },
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
      modelUsageFloatingVisible: false,
      conversationResume: {
        autoLoadLastConversationModelOnStartup: true,
        autoLoadLastConversationOnStartup: true,
        modelMismatchBehavior: 'ask',
        startupModelConnectCancelAfterMinutes: 2,
        startupModelConnectForceStopAfterMinutes: 5,
      },
      footerResourcePreference: 'auto',
      managedChatGptContextWindowMode: 'standard',
    });
    expect(store.get().closeBehavior).toBe('exit');
  });

  it('persists model mismatch and startup restore choices together', () => {
    const store = createStore();
    expect(
      store.set({
        conversationResume: {
          autoLoadLastConversationModelOnStartup: false,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'use-conversation',
          startupModelConnectCancelAfterMinutes: 3,
          startupModelConnectForceStopAfterMinutes: 8,
        },
      }),
    ).toMatchObject({
      conversationResume: {
        autoLoadLastConversationModelOnStartup: false,
        autoLoadLastConversationOnStartup: true,
        modelMismatchBehavior: 'use-conversation',
        startupModelConnectCancelAfterMinutes: 3,
        startupModelConnectForceStopAfterMinutes: 8,
      },
    });
  });

  it('migrates the former combined startup switch into both independent choices', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
    fixtureRoots.push(root);
    const directory = path.join(root, 'app-preferences');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'app.json'),
      JSON.stringify({
        claudeContextWindowMode: 'auto',
        closeBehavior: 'tray',
        closeToTrayNoticeShown: false,
        conversationResume: {
          modelMismatchBehavior: 'use-current',
          restoreLastWorkspaceOnStartup: false,
        },
        footerResourcePreference: 'auto',
        managedChatGptContextWindowMode: 'standard',
        version: 1,
      }),
      'utf8',
    );

    const store = new AppPreferencesStore(root);
    expect(store.get().conversationResume).toEqual({
      autoLoadLastConversationModelOnStartup: false,
      autoLoadLastConversationOnStartup: false,
      modelMismatchBehavior: 'use-current',
      startupModelConnectCancelAfterMinutes: 2,
      startupModelConnectForceStopAfterMinutes: 5,
    });
    expect(store.get().modelUsageFloatingVisible).toBe(false);
  });

  it('fills the new startup connection timings when loading an older version 2 file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
    fixtureRoots.push(root);
    const directory = path.join(root, 'app-preferences');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'app.json'),
      JSON.stringify({
        claudeContextWindowMode: 'auto',
        closeBehavior: 'tray',
        closeToTrayNoticeShown: false,
        modelUsageFloatingVisible: false,
        conversationResume: {
          autoLoadLastConversationModelOnStartup: true,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'ask',
        },
        footerResourcePreference: 'auto',
        managedChatGptContextWindowMode: 'standard',
        version: 2,
      }),
      'utf8',
    );

    expect(new AppPreferencesStore(root).get().conversationResume).toMatchObject({
      startupModelConnectCancelAfterMinutes: 2,
      startupModelConnectForceStopAfterMinutes: 5,
    });
  });

  it('migrates the legacy preferences directory to version 3 with hidden visibility', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
    fixtureRoots.push(root);
    const directory = path.join(root, 'preferences');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'app.json'),
      JSON.stringify({
        claudeContextWindowMode: 'auto',
        closeBehavior: 'tray',
        closeToTrayNoticeShown: false,
        conversationResume: {
          autoLoadLastConversationModelOnStartup: true,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'ask',
        },
        footerResourcePreference: 'auto',
        managedChatGptContextWindowMode: 'standard',
        version: 2,
      }),
      'utf8',
    );

    const store = new AppPreferencesStore(root);
    expect(store.get().modelUsageFloatingVisible).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(root, 'app-preferences', 'app.json'), 'utf8')),
    ).toMatchObject({
      modelUsageFloatingVisible: false,
      version: 3,
    });
  });

  it('rejects a hard deadline that is not later than the cancellation threshold', () => {
    const store = createStore();

    expect(() =>
      store.set({
        conversationResume: {
          autoLoadLastConversationModelOnStartup: true,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'ask',
          startupModelConnectCancelAfterMinutes: 5,
          startupModelConnectForceStopAfterMinutes: 5,
        },
      }),
    ).toThrow('应用偏好设置无效');
  });

  it('persists the explicit floating quota visibility choice independently', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
    fixtureRoots.push(directory);
    const store = new AppPreferencesStore(directory);
    expect(store.set({ modelUsageFloatingVisible: true }).modelUsageFloatingVisible).toBe(true);
    expect(new AppPreferencesStore(directory).get().modelUsageFloatingVisible).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(directory, 'app-preferences', 'app.json'), 'utf8')),
    ).toMatchObject({
      modelUsageFloatingVisible: true,
      version: 3,
    });
  });

  it('defaults invalid floating quota visibility data to hidden', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preferences-'));
    fixtureRoots.push(root);
    const directory = path.join(root, 'app-preferences');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'app.json'),
      JSON.stringify({
        claudeContextWindowMode: 'auto',
        closeBehavior: 'tray',
        closeToTrayNoticeShown: false,
        conversationResume: {
          autoLoadLastConversationModelOnStartup: true,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'ask',
        },
        footerResourcePreference: 'auto',
        managedChatGptContextWindowMode: 'standard',
        modelUsageFloatingVisible: 'yes',
        version: 3,
      }),
      'utf8',
    );

    expect(new AppPreferencesStore(root).get().modelUsageFloatingVisible).toBe(false);
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
