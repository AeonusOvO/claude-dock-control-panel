import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectivityObservation } from '../../src/main/network/provider-connectivity-probe';
import { NetworkDiagnosticsStore } from '../../src/main/network/diagnostics-store';
import { NetworkPreflightService } from '../../src/main/network/preflight-service';

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
  paths: [
    {
      detail: 'direct',
      dnsServers: ['1.1.1.1'],
      globalIpv6Available: false,
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

  it('starts a fresh check for callers that arrive after an invalidation', async () => {
    const root = createRoot();
    const releases: ((value: ConnectivityObservation) => void)[] = [];
    const run = vi.fn(
      () =>
        new Promise<ConnectivityObservation>((resolve) => {
          releases.push(resolve);
        }),
    );
    const service = new NetworkPreflightService({
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const input = { action: 'background' as const, provider: 'openai-codex' as const };

    const stale = service.run(input);
    expect(run).toHaveBeenCalledTimes(1);

    // Proxy or endpoint settings changed, so anything computed under the old configuration is void.
    service.invalidate('proxy-changed');

    // Reusing the superseded in-flight promise here hands the new caller a verdict computed with
    // the configuration they just replaced.
    const fresh = service.run(input);
    expect(run).toHaveBeenCalledTimes(2);
    expect(fresh).not.toBe(stale);

    for (const release of releases) {
      release(successfulObservation());
    }
    await Promise.all([stale, fresh]);
  });
});
