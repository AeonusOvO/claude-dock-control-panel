import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkPreflightAction, NetworkPreflightScope } from '../../src/shared/contracts';
import { automaticNetworkPreflightEnabled } from '../../src/shared/network-preflight-policy';
import { NetworkDiagnosticsStore } from '../../src/main/network/diagnostics-store';
import {
  NetworkPreflightLeaseContextError,
  NetworkPreflightService,
} from '../../src/main/network/preflight-service';
import {
  ProviderAccessBlockedError,
  ProviderAccessContextExpiredError,
  ProviderAccessGuard,
} from '../../src/main/network/provider-access-guard';
import { AdvancedSettingsStore } from '../../src/main/stores/advanced-settings';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createHarness = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-auto-preflight-'));
  roots.push(root);
  const settings = new AdvancedSettingsStore(root);
  const preferences = { checkOnNewSession: false, checkOnProviderLogin: false };
  const save = () => settings.set({ ...settings.get(), networkPreflight: { ...preferences } });
  save();
  const releases = vi.fn();
  const acquireNetworkLease = vi.fn(
    async (requested: NetworkPreflightScope | readonly NetworkPreflightScope[]) => {
      const scopes = typeof requested === 'string' ? [requested] : requested;
      let released = false;
      return {
        assertCurrent: () => {
          if (released) throw new Error('released route');
        },
        epochs: Object.fromEntries(scopes.map((scope) => [scope, 'fixture-route'])),
        release: () => {
          released = true;
          releases();
        },
        scopes,
      };
    },
  );
  const probe = vi.fn(async () => ({
    paths: [],
    probes: [
      {
        checkedAt: Date.now(),
        detail: 'reachable',
        id: 'app:openai-chatgpt',
        kind: 'https' as const,
        label: 'ChatGPT',
        process: 'application' as const,
        required: true,
        status: 'passed' as 'passed' | 'failed',
      },
    ],
  }));
  const environmentProbe = vi.fn(async () => undefined);
  const onResult = vi.fn();
  const diagnostics = new NetworkDiagnosticsStore(root);
  const service = new NetworkPreflightService({
    acquireNetworkLease,
    diagnosticsStore: diagnostics,
    environmentProbe: { run: environmentProbe },
    onResult,
    probe: { run: probe },
    shouldAssessEnvironment: () => true,
  });
  // Reopen the store just as a restarted main process would; each admission reads saved settings.
  const savedSettings = new AdvancedSettingsStore(root);
  const guard = new ProviderAccessGuard(
    service,
    () => true,
    (request) =>
      automaticNetworkPreflightEnabled(savedSettings.get().networkPreflight, request.action),
  );
  const request = { action: 'login' as const, cwd: root, provider: 'openai-codex' as const };
  return {
    acquireNetworkLease,
    diagnostics,
    environmentProbe,
    guard,
    onResult,
    preferences,
    probe,
    releases,
    request,
    save,
    service,
  };
};

describe('disabled automatic network preflight', () => {
  it.each<NetworkPreflightAction>([
    'background',
    'cli-launch',
    'cloud-task',
    'first-request',
    'login',
    'provider-switch',
  ])('does not probe or manufacture successful evidence for %s', async (action) => {
    const harness = createHarness();
    const operation = vi.fn(() => 'continued');
    await expect(
      harness.guard.withAllowed({ ...harness.request, action }, operation),
    ).resolves.toBe('continued');
    expect(operation).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(harness.probe).not.toHaveBeenCalled();
    expect(harness.environmentProbe).not.toHaveBeenCalled();
    expect(harness.onResult).not.toHaveBeenCalled();
    expect(harness.diagnostics.getView().entries).toHaveLength(0);
    expect(harness.acquireNetworkLease).toHaveBeenCalledOnce();
    expect(harness.releases).toHaveBeenCalledOnce();
  });

  it('uses newly saved preferences without restarting the guard', async () => {
    const harness = createHarness();
    await harness.guard.withAllowed(harness.request, () => undefined);
    expect(harness.probe).not.toHaveBeenCalled();
    harness.preferences.checkOnProviderLogin = true;
    harness.save();
    await harness.guard.withAllowed(harness.request, (result) => expect(result).toBeDefined());
    expect(harness.probe).toHaveBeenCalledOnce();
    harness.preferences.checkOnProviderLogin = false;
    harness.save();
    await harness.guard.withAllowed(harness.request, (result) => expect(result).toBeUndefined());
    expect(harness.probe).toHaveBeenCalledOnce();
  });

  it('keeps explicit manual checks working with both automatic switches off', async () => {
    const harness = createHarness();
    await harness.service.run({ ...harness.request, action: 'background', force: true });
    expect(harness.probe).toHaveBeenCalledOnce();
    expect(harness.environmentProbe).toHaveBeenCalledOnce();
    expect(harness.diagnostics.getView().entries).toHaveLength(1);
  });

  it('does not reuse a previous blocked verdict after automatic checks are disabled', async () => {
    const harness = createHarness();
    harness.probe.mockResolvedValue({
      paths: [],
      probes: [
        {
          checkedAt: Date.now(),
          detail: 'TLS certificate invalid',
          id: 'app:openai-chatgpt',
          kind: 'https',
          label: 'ChatGPT',
          process: 'application',
          required: true,
          status: 'failed',
        },
      ],
    });
    harness.preferences.checkOnProviderLogin = true;
    harness.save();
    await expect(harness.guard.withAllowed(harness.request, vi.fn())).rejects.toBeInstanceOf(
      ProviderAccessBlockedError,
    );
    harness.preferences.checkOnProviderLogin = false;
    harness.save();
    await expect(harness.guard.withAllowed(harness.request, () => 'continued')).resolves.toBe(
      'continued',
    );
    expect(harness.probe).toHaveBeenCalledOnce();
    expect(harness.diagnostics.getView().entries).toHaveLength(1);
  });

  it('reuses the parent route for nested operations without any diagnostic probe', async () => {
    const harness = createHarness();
    await harness.guard.withAllowed(harness.request, async () => {
      await harness.guard.withAllowed(
        { ...harness.request, action: 'first-request' },
        () => 'nested',
      );
      expect(harness.releases).not.toHaveBeenCalled();
    });
    expect(harness.acquireNetworkLease).toHaveBeenCalledOnce();
    expect(harness.releases).toHaveBeenCalledOnce();
    expect(harness.probe).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'anthropic-claude' as const },
    { networkScope: 'conversation' as const },
    { cwd: path.resolve('another-preflight-project') },
    { target: { process: 'application' as const, url: 'https://example.test/' } },
  ])('does not let disabling probes broaden a nested route: %j', async (mismatch) => {
    const harness = createHarness();
    const nested = vi.fn();
    await harness.guard.withAllowed(harness.request, async () => {
      await expect(
        harness.guard.withAllowed({ ...harness.request, ...mismatch }, nested),
      ).rejects.toBeInstanceOf(NetworkPreflightLeaseContextError);
    });
    expect(nested).not.toHaveBeenCalled();
    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('still checks a nested action whose own preference is enabled', async () => {
    const harness = createHarness();
    harness.preferences.checkOnNewSession = true;
    harness.save();
    await harness.guard.withAllowed(harness.request, async (result) => {
      expect(result).toBeUndefined();
      expect(harness.probe).not.toHaveBeenCalled();
      await harness.guard.withAllowed({ ...harness.request, action: 'first-request' }, (nested) => {
        expect(nested).toBeDefined();
      });
    });
    expect(harness.probe).toHaveBeenCalledOnce();
    expect(harness.acquireNetworkLease).toHaveBeenCalledOnce();
  });

  it('rejects inherited work after a disabled-check operation has settled', async () => {
    const harness = createHarness();
    let late: Promise<unknown> | undefined;
    await harness.guard.withAllowed(harness.request, () => {
      queueMicrotask(() => {
        late = harness.guard.withAllowed(harness.request, () => 'late');
        void late.catch(() => undefined);
      });
    });
    await expect(late).rejects.toBeInstanceOf(ProviderAccessContextExpiredError);
    expect(harness.acquireNetworkLease).toHaveBeenCalledOnce();
  });

  it('uses the captured action for preferences after an inherited async checkpoint', async () => {
    const harness = createHarness();
    await harness.guard.withAllowed({ ...harness.request, action: 'first-request' }, async () => {
      harness.preferences.checkOnProviderLogin = true;
      harness.save();
      const mutable = { ...harness.request, action: 'login' as NetworkPreflightAction };
      const nested = harness.guard.withAllowed(mutable, (result) => {
        expect(result?.action).toBe('login');
      });
      mutable.action = 'first-request';
      await nested;
    });
    expect(harness.probe).toHaveBeenCalledOnce();
  });

  it('holds the route until an already-started cancelled callback unwinds', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let enter!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const drain = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation = harness.guard.withAllowed(
      harness.request,
      async () => {
        enter();
        await drain;
      },
      controller.signal,
    );
    const cancelled = expect(operation).rejects.toThrow('cancelled during login');
    await started;
    controller.abort(new Error('cancelled during login'));
    expect(harness.releases).not.toHaveBeenCalled();
    finish();
    await cancelled;
    expect(harness.releases).toHaveBeenCalledOnce();
    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('does not admit an already cancelled operation or retry a failed operation', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const operation = vi.fn(() => {
      throw new Error('operation failed');
    });
    await expect(
      harness.guard.withAllowed(harness.request, operation, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(operation).not.toHaveBeenCalled();
    expect(harness.acquireNetworkLease).not.toHaveBeenCalled();
    await expect(harness.guard.withAllowed(harness.request, operation)).rejects.toThrow(
      'operation failed',
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(harness.releases).toHaveBeenCalledOnce();
  });
});
