import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { installModelUsage } from '../../src/main/app/model-usage';
import { Registry } from '../../src/main/infra/registry';
import {
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MODEL_USAGE_SERVICE,
} from '../../src/main/infra/service-tokens';
import type { RuntimeProfile } from '../../src/main/app/profile';

vi.mock('../../src/main/app/model-usage-window', () => ({
  ModelUsageWindow: class {
    public publish = vi.fn();
  },
}));

describe('subscription quota account binding', () => {
  it.each([true, false])(
    'uses only the managed account without a separate Codex login (real runtimes: %s)',
    async (allowRealRuntimes) => {
      const root = await mkdtemp(path.join(tmpdir(), 'claudedock-quota-binding-'));
      const services = new Registry();
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
      services.register(CLAUDE_RUNTIME, () => ({ setModelUsageObserver: vi.fn() }) as never);
      services.register(CODEX_RUNTIME, codex);
      services.register(MAIN_WINDOW, () => ({ current: undefined }) as never);
      services.register(
        MANAGED_CHATGPT_GATEWAY,
        () =>
          ({
            getUsageAccountIdentity: async () => 'managed@example.com',
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
      );
      const usage = services.resolve(MODEL_USAGE_SERVICE);
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
});
