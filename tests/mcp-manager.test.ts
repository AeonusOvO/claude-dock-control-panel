import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverMcpServers } from '../src/main/mcp-manager';
import { CURATED_MCP_SERVERS } from '../src/shared/mcp-catalog';

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
});
