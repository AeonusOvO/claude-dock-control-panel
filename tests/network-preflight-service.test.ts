import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectivityObservation } from '../src/main/provider-connectivity-probe';
import { NetworkDiagnosticsStore } from '../src/main/network-diagnostics-store';
import { NetworkPreflightService } from '../src/main/network-preflight-service';
import { NetworkPreflightSettingsStore } from '../src/main/network-preflight-settings-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-preflight-service-'));
  roots.push(root);
  return root;
};

const successfulObservation = (): ConnectivityObservation => ({
  egress: {
    countryCode: 'US',
    sourceCount: 2,
    sourcesAgree: true,
    stability: 'unknown',
  },
  paths: [
    {
      detail: 'direct',
      dnsServers: ['1.1.1.1'],
      ipv4Available: true,
      ipv6Available: false,
      process: 'application',
      proxyConfigured: false,
      proxyKind: 'direct',
      virtualInterfaces: [],
    },
  ],
  probes: [
    {
      checkedAt: Date.now(),
      detail: 'reachable',
      id: 'app:openai-chatgpt',
      kind: 'https',
      label: 'ChatGPT',
      process: 'application',
      required: true,
      status: 'passed',
    },
  ],
});

describe('NetworkPreflightService', () => {
  it('deduplicates concurrent checks and reuses a fresh cache', async () => {
    const root = createRoot();
    let release: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          release = resolve;
        }),
    );
    const service = new NetworkPreflightService({
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
      settingsStore: new NetworkPreflightSettingsStore(root),
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };

    const first = service.run(input);
    const second = service.run(input);
    expect(first).toBe(second);
    expect(run).toHaveBeenCalledTimes(1);
    release?.(successfulObservation());
    await first;

    await service.run(input);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('invalidates stale in-flight work without persisting it as the current result', async () => {
    const root = createRoot();
    let release: ((value: ConnectivityObservation) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          release = resolve;
        }),
    );
    const diagnosticsStore = new NetworkDiagnosticsStore(root);
    const service = new NetworkPreflightService({
      diagnosticsStore,
      probe: { run },
      settingsStore: new NetworkPreflightSettingsStore(root),
    });
    const operation = service.run({
      action: 'background',
      provider: 'openai-codex',
    });
    service.invalidate('network-changed');
    release?.(successfulObservation());
    await operation;

    expect(diagnosticsStore.getView().entries).toHaveLength(0);
  });
});
