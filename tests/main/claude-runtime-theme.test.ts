import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeClaudeConfig } from '../../src/main/claude/configuration';
import { ClaudeRuntime, claudeCodeThemeForTerminalTheme } from '../../src/main/claude/runtime';

describe('Claude runtime terminal theme', () => {
  it('maps application appearances to explicit Claude Code themes', () => {
    expect(claudeCodeThemeForTerminalTheme('claude')).toBe('light');
    expect(claudeCodeThemeForTerminalTheme('telegram')).toBe('light');
    expect(claudeCodeThemeForTerminalTheme('graphite')).toBe('dark');
    expect(claudeCodeThemeForTerminalTheme('midnight')).toBe('dark');
  });

  it('writes the current application theme into each new owned session settings file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-runtime-theme-'));
    const runtime = new ClaudeRuntime(
      root,
      path.join(root, 'statusline.ps1'),
      path.join(root, 'signal.ps1'),
      path.join(root, 'guard.ps1'),
      () => false,
      () => 'standard',
      () => ({ mode: 'auto' }),
      () => undefined,
      () => true,
      async () => undefined,
      async () => undefined,
      () => undefined,
      fetch,
      'telegram',
    );
    const config = normalizeClaudeConfig({
      authMode: 'authToken',
      baseUrl: 'https://relay.example.com',
      credentialAction: 'keep',
      model: 'claude-fable-5',
      preset: 'custom',
      provider: 'gateway',
    });
    const snapshot = {
      allowBypassPermissions: false,
      config,
      credential: 'test-token',
      storage: { revision: 'theme-test' },
    };
    const internals = runtime as unknown as {
      configStore: {
        createLaunchSnapshot: () => typeof snapshot;
        launchSnapshotIsCurrent: (_cwd: string, candidate: typeof snapshot) => boolean;
      };
      diagnoseInstallation: () => Promise<{
        executable: string;
        installationKind: 'native';
        installed: true;
        message: string;
        security: 'ready';
        version: string;
      }>;
      prepareRouteServices: () => Promise<void>;
      sessions: Map<string, { settingsPath?: string }>;
    };
    internals.configStore.createLaunchSnapshot = vi.fn(() => snapshot);
    internals.configStore.launchSnapshotIsCurrent = vi.fn(
      (_cwd, candidate) => candidate === snapshot,
    );
    internals.diagnoseInstallation = vi.fn(
      async () =>
        ({
          executable: 'C:\\Tools\\claude.exe',
          installationKind: 'native',
          installed: true,
          message: 'Claude Code 已就绪。',
          security: 'ready',
          version: '2.1.221',
        }) as const,
    );
    internals.prepareRouteServices = vi.fn(async () => undefined);

    const readTheme = async (sessionId: string): Promise<string> => {
      await runtime.prepareLaunch(sessionId, 'D:\\Project', 'new');
      const settingsPath = internals.sessions.get(sessionId)?.settingsPath;
      if (!settingsPath) throw new Error('Claude settings file was not prepared.');
      return (JSON.parse(readFileSync(settingsPath, 'utf8')) as { theme: string }).theme;
    };

    try {
      expect(await readTheme('theme-light')).toBe('light');
      runtime.setTheme('graphite');
      expect(await readTheme('theme-dark')).toBe('dark');
    } finally {
      runtime.shutdown();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
