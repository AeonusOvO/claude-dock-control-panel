import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRouterManager, ROUTER_DATA_ENTRIES } from '../../src/main/claude/router-manager';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('CCR CLI-only profile boundary', () => {
  it('routes every configuration save through takeover-disabled RPC arguments', async () => {
    const manager = new ClaudeRouterManager('D:\\ClaudeDockData');
    const access = {
      managementUrl: 'http://127.0.0.1:3456/ui',
      origin: 'http://127.0.0.1:3456',
      pid: 4321,
      serviceToken: 'service-token',
      webToken: 'web-token',
    };
    const config = { Providers: [{ name: 'Example' }] };
    const rpcWithAccess = vi.fn(async () => config);
    const internals = manager as unknown as {
      rpcWithAccess: typeof rpcWithAccess;
      saveConfigWithoutProfileTakeover(
        service: typeof access,
        value: typeof config,
        secrets?: string[],
      ): Promise<typeof config>;
    };
    internals.rpcWithAccess = rpcWithAccess;

    await expect(
      internals.saveConfigWithoutProfileTakeover(access, config, ['secret-value']),
    ).resolves.toBe(config);
    expect(rpcWithAccess).toHaveBeenCalledOnce();
    expect(rpcWithAccess).toHaveBeenCalledWith(
      access,
      'saveConfig',
      [config, { applyProfile: false }],
      ['secret-value'],
    );
  });

  it('exports historical takeover artifacts only as scoped CCR purge entries', () => {
    expect(ROUTER_DATA_ENTRIES).toEqual(
      expect.arrayContaining(['claude-app-gateway-backup.json', 'global-profile-takeover.json']),
    );
    expect(ROUTER_DATA_ENTRIES).not.toContain('claude_desktop_config.json');
  });

  it('leaves Claude Desktop configuration byte-identical when only Desktop CCR is present', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-router-boundary-'));
    roots.push(root);
    const desktopConfig = path.join(root, 'Claude', 'claude_desktop_config.json');
    mkdirSync(path.dirname(desktopConfig), { recursive: true });
    const original = Buffer.from('{"mcpServers":{"keep":true}}\n');
    writeFileSync(desktopConfig, original);
    const manager = new ClaudeRouterManager(path.join(root, 'user-data'));
    const internals = manager as unknown as {
      findCliInstallation(): Promise<undefined>;
      findDesktopExecutable(): string;
      getActiveServiceAccess(): Promise<undefined>;
    };
    internals.findCliInstallation = vi.fn(async () => undefined);
    internals.findDesktopExecutable = vi.fn(() => path.join(root, 'CCR', 'ccr-desktop.exe'));
    internals.getActiveServiceAccess = vi.fn(async () => undefined);

    await expect(manager.uninstall()).resolves.toMatchObject({
      message: '仅检测到 CCR 桌面版；ClaudeDock 不会卸载或修改它。',
      state: { canUninstall: false, installationKind: 'desktop' },
    });
    expect(readFileSync(desktopConfig)).toEqual(original);
  });
});
