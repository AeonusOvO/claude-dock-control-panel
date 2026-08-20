import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverMcpServers } from '../../src/main/mcp/manager';
import { McpManager } from '../../src/main/mcp/manager';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import { CURATED_MCP_SERVERS } from '../../src/shared/ui/mcp-catalog';
import { createRendererHarness } from '../helpers/renderer-harness';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('MCP discovery', () => {
  it('keeps Claude scopes, Codex origin, source paths and disabled state distinct', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const normalizedCwd = cwd.replaceAll('\\', '/');
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { userServer: { command: 'node' } },
        projects: {
          [normalizedCwd]: {
            disabledMcpjsonServers: ['sharedServer'],
            enabledMcpjsonServers: [],
            mcpServers: { localServer: { type: 'sse', url: 'https://example.com/sse' } },
          },
        },
      }),
    );
    writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: { sharedServer: { type: 'http', url: 'https://example.com/mcp' } },
      }),
    );
    writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex_server]\ncommand = "node"\n',
    );

    const servers = discoverMcpServers(home, cwd);
    expect(
      servers.map(({ client, enabled, name, scope, transport }) => ({
        client,
        enabled,
        name,
        scope,
        transport,
      })),
    ).toEqual([
      { client: 'claude', enabled: true, name: 'userServer', scope: 'user', transport: 'stdio' },
      { client: 'claude', enabled: true, name: 'localServer', scope: 'local', transport: 'sse' },
      {
        client: 'claude',
        enabled: false,
        name: 'sharedServer',
        scope: 'project',
        transport: 'http',
      },
      { client: 'codex', enabled: true, name: 'codex_server', scope: 'user', transport: 'stdio' },
    ]);
    expect(servers.every((server) => path.isAbsolute(server.configPath))).toBe(true);
  });

  it('ships a usable offline curated catalog without secret requirements', () => {
    expect(CURATED_MCP_SERVERS.length).toBeGreaterThanOrEqual(3);
    expect(CURATED_MCP_SERVERS.every((entry) => entry.featured)).toBe(true);
    expect(CURATED_MCP_SERVERS.every((entry) => !entry.requiresCredential)).toBe(true);
  });

  it('exposes only explicit per-server MCP actions', async () => {
    const harness = await createRendererHarness();
    try {
      harness.click('[data-rail-tab="mcp"]');
      await harness.flush();

      const page = harness.query<HTMLElement>('[data-rail-page="mcp"]');
      expect(page.textContent).toContain('每次只安装你明确选择的一项');
      expect(page.querySelector('[data-mcp-action="install-all"]')).toBeNull();
      expect(page.querySelector('[data-mcp-action="sync-all"]')).toBeNull();
      expect(page.textContent).not.toMatch(/一键全装|同步全部 MCP/i);
    } finally {
      await harness.cleanup();
    }
  });

  it('previews, backs up, atomically toggles and byte-restores project MCP state', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-mcp-toggle-'));
    temporaryDirectories.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const userData = path.join(root, 'user-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const configPath = path.join(home, '.claude.json');
    const original = Buffer.from(
      `${JSON.stringify({
        projects: {
          [cwd.replaceAll('\\', '/')]: {
            disabledMcpjsonServers: [],
            enabledMcpjsonServers: ['sharedServer'],
          },
        },
      })}\n`,
    );
    writeFileSync(configPath, original);
    const manager = new McpManager(home, userData, new BusyRegistry());

    const preview = manager.previewToggle(cwd, 'sharedServer', false);
    expect(preview.targetPath).toBe(configPath);
    expect(preview.after).toContain('disabledMcpjsonServers');
    await manager.applyToggle(preview.id);
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')).projects[cwd.replaceAll('\\', '/')],
    ).toMatchObject({
      disabledMcpjsonServers: ['sharedServer'],
      enabledMcpjsonServers: [],
    });

    const [backup] = manager.listBackups();
    expect(backup).toBeDefined();
    await manager.restoreBackup(backup!.id, cwd);
    expect(readFileSync(configPath)).toEqual(original);
  });
});
