import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkPreflightScope } from '../../src/shared/contracts';
import { NetworkDiagnosticsStore } from '../../src/main/network/diagnostics-store';
import { NetworkPreflightService } from '../../src/main/network/preflight-service';
import { ProviderAccessGuard } from '../../src/main/network/provider-access-guard';
import { ProviderConnectivityProbe } from '../../src/main/network/provider-connectivity-probe';
import { RiskDecisionEngine } from '../../src/main/network/risk-decision-engine';

const roots: string[] = [];
const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock portable '));
  roots.push(root);
  return root;
};
const acquireNetworkLease = async (
  requested: NetworkPreflightScope | readonly NetworkPreflightScope[],
) => {
  const scopes = typeof requested === 'string' ? [requested] : requested;
  return {
    assertCurrent: () => undefined,
    epochs: Object.fromEntries(scopes.map((scope) => [scope, 'test-epoch'])),
    release: () => undefined,
    scopes,
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('network preflight working directory', () => {
  it.each(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])(
    'reports %s as a local probe startup failure, not a remote account or DNS failure',
    async (code) => {
      const probe = new ProviderConnectivityProbe({
        applicationRequest: async () => ({ contentType: '', redirects: [], status: 204 }),
        cliRequest: async () => {
          throw Object.assign(new Error(`spawn curl.exe ${code}`), {
            code,
            syscall: 'spawn curl.exe',
          });
        },
        dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
        resolveProxy: async () => 'DIRECT',
      });
      const observation = await probe.run('openai-codex', 'login');
      const result = new RiskDecisionEngine().evaluate('openai-codex', 'login', observation, 1, 2);
      expect(result.providerConnectivity.status).toBe('blocked');
      expect(result.providerConnectivity.reasons.join(' ')).toContain('请求尚未发出');
      expect(result.providerConnectivity.reasons.join(' ')).toContain('检查本机探测组件');
      expect(result.providerConnectivity.reasons.join(' ')).not.toContain('域名白名单');
      expect(result.providerConnectivity.signals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'local-process-unavailable:cli:openai-codex-api' }),
        ]),
      );
    },
  );
  it('keeps a nonexistent configuration identity out of subprocess working directories', async () => {
    const root = createRoot();
    const commandDirectory = path.join(root, '应用数据 with spaces');
    mkdirSync(commandDirectory);
    const configScope = path.join(root, 'claude', 'next-conversation-profile');
    const cliRequest = vi.fn(async (url: string) => `401|${url}|0|application/json`);
    const probe = new ProviderConnectivityProbe({
      applicationRequest: async () => ({ contentType: '', redirects: [], status: 204 }),
      cliRequest,
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    });
    const service = new NetworkPreflightService({
      acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe,
      probeWorkingDirectory: commandDirectory,
    });
    const guard = new ProviderAccessGuard(service);
    const request = {
      action: 'login' as const,
      cwd: configScope,
      provider: 'openai-codex' as const,
    };
    const operation = vi.fn(async () => {
      await guard.withAllowed(request, (nested) => {
        expect(nested).toMatchObject({ canonicalCwd: configScope });
      });
      await expect(
        guard.withAllowed({ ...request, cwd: path.join(root, 'another-profile') }, vi.fn()),
      ).rejects.toThrow();
    });

    await guard.withAllowed(request, operation);

    expect(operation).toHaveBeenCalledOnce();
    expect(cliRequest).toHaveBeenCalled();
    for (const call of cliRequest.mock.calls as unknown[][]) expect(call[2]).toBe(commandDirectory);
    expect(existsSync(configScope)).toBe(false);
  });

  it('defaults to the current user home instead of an authorization scope or install directory', async () => {
    const root = createRoot();
    const run = vi.fn(async () => ({ paths: [], probes: [] }));
    const service = new NetworkPreflightService({
      acquireNetworkLease,
      diagnosticsStore: new NetworkDiagnosticsStore(root),
      probe: { run },
    });
    const configScope = path.join(root, 'missing-profile');
    const result = await service.run({
      action: 'login',
      cwd: configScope,
      provider: 'openai-codex',
    });

    expect(run).toHaveBeenCalledWith(
      'openai-codex',
      'login',
      homedir(),
      'application',
      undefined,
      expect.any(AbortSignal),
    );
    expect(result.canonicalCwd).toBe(configScope);
    expect(existsSync(configScope)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'runs the real Windows curl transport with an absent profile and a relocated Unicode data directory',
    async () => {
      const root = createRoot();
      const commandDirectory = path.join(root, '其他用户 数据');
      mkdirSync(commandDirectory);
      const configScope = path.join(root, 'claude', 'next-conversation-profile');
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.method ?? '');
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
        const url = `http://127.0.0.1:${address.port}/probe`;
        const service = new NetworkPreflightService({
          acquireNetworkLease,
          diagnosticsStore: new NetworkDiagnosticsStore(root),
          probe: new ProviderConnectivityProbe({
            applicationRequest: async () => ({ contentType: '', redirects: [], status: 204 }),
            cliEnvironment: () => ({
              ALL_PROXY: null,
              all_proxy: null,
              HTTP_PROXY: null,
              http_proxy: null,
              HTTPS_PROXY: null,
              https_proxy: null,
              NO_PROXY: '*',
              no_proxy: '*',
            }),
            dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
            resolveProxy: async () => 'DIRECT',
          }),
          probeWorkingDirectory: commandDirectory,
        });
        const operation = vi.fn();
        await new ProviderAccessGuard(service).withAllowed(
          {
            action: 'login',
            cwd: configScope,
            provider: 'openai-codex',
            target: { process: 'claude-cli', url },
          },
          operation,
        );

        expect(operation).toHaveBeenCalledOnce();
        expect(requests).toEqual(['GET']);
        expect(existsSync(configScope)).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
