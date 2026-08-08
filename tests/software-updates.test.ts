import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeInstallationStatus,
  ClaudeRouterManagementState,
} from '../src/shared/contracts';
import {
  checkSoftwareUpdates,
  isNewerVersion,
  selectFastestClaudeRegistry,
  sanitizeSoftwareUpdateLine,
} from '../src/main/software-updates';

describe('software update version comparison', () => {
  it('compares semantic versions without lexical ordering errors', () => {
    expect(isNewerVersion('2.10.0', '2.9.9')).toBe(true);
    expect(isNewerVersion('3.0.0', '2.99.99')).toBe(true);
    expect(isNewerVersion('2.1.220', '2.1.220')).toBe(false);
    expect(isNewerVersion('2.1.219', '2.1.220')).toBe(false);
  });

  it('does not claim an update when either version cannot be verified', () => {
    expect(isNewerVersion(undefined, '2.1.220')).toBe(false);
    expect(isNewerVersion('latest', '2.1.220')).toBe(false);
  });

  it('uses the injected Electron-session fetch and races both npm registries', async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ tag_name: 'v3.5.0' }), { status: 200 });
      }
      if (url.includes('registry.npmmirror.com')) {
        return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 });
      }
      // A stalled official registry must not hold the mirror result for another full timeout.
      return new Promise<Response>(() => undefined);
    });
    const installation: ClaudeInstallationStatus = {
      installationKind: 'npm',
      installed: true,
      message: '',
      security: 'ready',
      version: '1.0.0',
    };
    const router = {
      installed: true,
      version: '1.0.0',
    } as ClaudeRouterManagementState;

    const result = await checkSoftwareUpdates(installation, router, '3.4.0', fetchMock);

    expect(result.application.latestVersion).toBe('3.5.0');
    expect(result.claudeCode.latestVersion).toBe('9.9.9');
    expect(result.router.latestVersion).toBe('9.9.9');
    expect(requested.some((url) => url.includes('registry.npmjs.org'))).toBe(true);
    expect(requested.some((url) => url.includes('registry.npmmirror.com'))).toBe(true);
  });

  it('uses a small tarball sample to choose the faster compatible npm registry', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/-/')) {
        return new Response(new Uint8Array(128 * 1024), { status: 206 });
      }
      const registry = url.includes('npmmirror')
        ? 'https://registry.npmmirror.com'
        : 'https://registry.npmjs.org';
      return new Response(
        JSON.stringify({
          dist: url.includes('npmmirror')
            ? { tarball: `${registry}/@anthropic-ai/claude-code/-/claude-code-9.9.9.tgz` }
            : undefined,
          version: '9.9.9',
        }),
        { status: 200 },
      );
    });

    const selected = await selectFastestClaudeRegistry(fetchMock);

    expect(selected.label).toBe('npmmirror 国内镜像');
    expect(selected.bytesPerSecond).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('claude-code-9.9.9.tgz'),
      expect.objectContaining({ headers: expect.objectContaining({ range: expect.any(String) }) }),
    );
  });

  it('redacts credentials, tokens and local paths from streamed operation logs', () => {
    const sanitized = sanitizeSoftwareUpdateLine(
      'fetch https://user:password@example.com/pkg?token=abc C:\\Users\\Cheng\\secret npm_privateToken',
    );
    expect(sanitized).toContain('[credentials]');
    expect(sanitized).toContain('token=[redacted]');
    expect(sanitized).toContain('[local path]');
    expect(sanitized).not.toContain('password');
    expect(sanitized).not.toContain('Cheng');
    expect(sanitized).not.toContain('npm_privateToken');
  });
});
