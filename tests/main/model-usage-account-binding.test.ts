import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installModelUsage } from '../../src/main/app/model-usage';
import { Registry } from '../../src/main/infra/registry';
import {
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MODEL_USAGE_SERVICE,
  MODEL_USAGE_WINDOW,
} from '../../src/main/infra/service-tokens';
import type { RuntimeProfile } from '../../src/main/app/profile';

const usageWindows = vi.hoisted(
  () =>
    [] as {
      onVisibility: (visible: boolean) => void;
      onVisibilityRequest: (visible: boolean) => void;
      setVisible: ReturnType<typeof vi.fn>;
    }[],
);
const usageWindowOpenFailure = vi.hoisted(() => ({ current: undefined as Error | undefined }));
vi.mock('../../src/main/app/model-usage-window', () => ({
  ModelUsageWindow: class {
    public readonly setVisible = vi.fn(async (visible: boolean) => {
      if (visible && usageWindowOpenFailure.current) throw usageWindowOpenFailure.current;
      this.onVisibilityRequest(visible);
      this.onVisibility(visible);
    });
    public publish = vi.fn();
    public constructor(
      private readonly onVisibility: (visible: boolean) => void,
      private readonly onVisibilityRequest: (visible: boolean) => void,
    ) {
      usageWindows.push({ onVisibility, onVisibilityRequest, setVisible: this.setVisible });
    }
  },
}));

afterEach(() => {
  usageWindows.length = 0;
  usageWindowOpenFailure.current = undefined;
});

describe('subscription quota account binding', () => {
  it.each([true, false])(
    'uses only the managed account without a separate Codex login (real runtimes: %s)',
    async (allowRealRuntimes) => {
      const root = await mkdtemp(path.join(tmpdir(), 'claudedock-quota-binding-'));
      const services = new Registry();
      const appPreferencesStore = {
        get: vi.fn(() => ({
          claudeContextWindowMode: 'auto' as const,
          closeBehavior: 'tray' as const,
          closeToTrayNoticeShown: false,
          conversationResume: {
            autoLoadLastConversationModelOnStartup: true,
            autoLoadLastConversationOnStartup: true,
            modelMismatchBehavior: 'ask' as const,
            startupModelConnectCancelAfterMinutes: 2,
            startupModelConnectForceStopAfterMinutes: 5,
          },
          footerResourcePreference: 'auto' as const,
          managedChatGptContextWindowMode: 'standard' as const,
          modelUsageFloatingVisible: false,
        })),
        set: vi.fn(),
      };
      const codex = vi.fn(() => {
        throw new Error('No independent Codex installation or login');
      });
      const readAccountResourceUsage = vi.fn(async () => ({
        availability: 'available',
        capabilities: { balance: false, context: false, windows: true },
        source: 'managed-chatgpt-gateway',
        checkedAt: Date.now(),
        windows: [{ label: '5 小时', usedPercent: 37 }],
      }));
      let publishQuotaInvalidated: ((kind: 'lifecycle' | 'account') => void) | undefined;
      let publishQuotaReadable: (() => void) | undefined;
      services.register(CLAUDE_RUNTIME, () => ({ setModelUsageObserver: vi.fn() }) as never);
      services.register(CODEX_RUNTIME, codex);
      services.register(MAIN_WINDOW, () => ({ current: undefined }) as never);
      services.register(
        MANAGED_CHATGPT_GATEWAY,
        () =>
          ({
            getUsageAccountIdentity: async () => 'managed@example.com',
            onQuotaInvalidated: (listener: (kind: 'lifecycle' | 'account') => void) => {
              publishQuotaInvalidated = listener;
              return () => {
                if (publishQuotaInvalidated === listener) publishQuotaInvalidated = undefined;
              };
            },
            onQuotaReadable: (listener: () => void) => {
              publishQuotaReadable = listener;
              return () => {
                if (publishQuotaReadable === listener) publishQuotaReadable = undefined;
              };
            },
            readAccountResourceUsage,
          }) as never,
      );
      installModelUsage(
        services,
        {
          effects: { allowRealRuntimes },
          paths: { userData: root, projects: path.join(root, 'projects') },
        } as RuntimeProfile,
        'claude',
        appPreferencesStore,
      );
      const usage = services.resolve(MODEL_USAGE_SERVICE);
      services.resolve(MODEL_USAGE_WINDOW);
      const usageWindow = usageWindows.at(-1);
      if (!usageWindow) throw new Error('Model usage window was not registered');
      usageWindow.onVisibilityRequest(true);
      expect(appPreferencesStore.set).toHaveBeenLastCalledWith({
        modelUsageFloatingVisible: true,
      });
      usageWindow.onVisibility(false);
      expect(appPreferencesStore.set).toHaveBeenLastCalledWith({
        modelUsageFloatingVisible: false,
      });
      try {
        usage.select({
          id: 'managed-connection',
          mode: 'subscription',
          preset: 'chatgpt-subscription',
          model: 'gpt-5.3-codex',
        });
        if (allowRealRuntimes) {
          await vi.waitFor(() => {
            expect(usage.getSnapshot().windows?.[0]?.remainingPercent).toBe(63);
          });
          expect(readAccountResourceUsage).toHaveBeenCalledOnce();
          if (!publishQuotaInvalidated || !publishQuotaReadable)
            throw new Error('Model usage did not subscribe to gateway quota lifecycle events');
          publishQuotaInvalidated('account');
          expect(usage.getSnapshot()).toMatchObject({
            status: 'stale',
            windows: [{ remainingPercent: 63 }],
          });
          publishQuotaReadable();
          await vi.waitFor(() => expect(readAccountResourceUsage).toHaveBeenCalledTimes(2));
          await vi.waitFor(() => expect(usage.getSnapshot().status).toBe('available'));
        } else {
          await Promise.resolve();
          expect(usage.getSnapshot().status).toBe('unavailable');
          expect(readAccountResourceUsage).not.toHaveBeenCalled();
        }
        expect(codex).not.toHaveBeenCalled();
      } finally {
        usage.dispose();
        await Reflect.get(usage, 'writes');
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps a remembered visible preference when startup restoration fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudedock-quota-restoration-'));
    const services = new Registry();
    const appPreferencesStore = {
      get: vi.fn(() => ({
        claudeContextWindowMode: 'auto' as const,
        closeBehavior: 'tray' as const,
        closeToTrayNoticeShown: false,
        conversationResume: {
          autoLoadLastConversationModelOnStartup: true,
          autoLoadLastConversationOnStartup: true,
          modelMismatchBehavior: 'ask' as const,
          startupModelConnectCancelAfterMinutes: 2,
          startupModelConnectForceStopAfterMinutes: 5,
        },
        footerResourcePreference: 'auto' as const,
        managedChatGptContextWindowMode: 'standard' as const,
        modelUsageFloatingVisible: true,
      })),
      set: vi.fn(),
    };
    usageWindowOpenFailure.current = new Error('widget unavailable');
    services.register(CLAUDE_RUNTIME, () => ({ setModelUsageObserver: vi.fn() }) as never);

    installModelUsage(
      services,
      {
        effects: { allowRealRuntimes: false },
        paths: { userData: root, projects: path.join(root, 'projects') },
      } as RuntimeProfile,
      'claude',
      appPreferencesStore,
    );

    const usageWindow = usageWindows.at(-1);
    if (!usageWindow) throw new Error('Model usage window was not registered');
    await vi.waitFor(() => expect(usageWindow.setVisible).toHaveBeenCalledWith(true));
    expect(appPreferencesStore.set).not.toHaveBeenCalled();

    const usage = services.resolve(MODEL_USAGE_SERVICE);
    usage.dispose();
    await Reflect.get(usage, 'writes');
    await rm(root, { recursive: true, force: true });
  });
});
