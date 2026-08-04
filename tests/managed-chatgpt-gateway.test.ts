import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveEntriesAreSafe,
  buildManagedGatewayConfig,
  parseCliProxyApiRelease,
} from '../src/main/managed-chatgpt-gateway';

const releasePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  assets: [
    {
      browser_download_url:
        'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.116/CLIProxyAPI_7.2.116_windows_amd64.zip',
      digest: `sha256:${'a'.repeat(64)}`,
      name: 'CLIProxyAPI_7.2.116_windows_amd64.zip',
      size: 21_044_954,
    },
  ],
  tag_name: 'v7.2.116',
  ...overrides,
});

describe('managed ChatGPT gateway', () => {
  it('accepts only the matching upstream Windows x64 release asset', () => {
    expect(parseCliProxyApiRelease(releasePayload())).toEqual({
      digest: 'a'.repeat(64),
      downloadUrl:
        'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.116/CLIProxyAPI_7.2.116_windows_amd64.zip',
      fileName: 'CLIProxyAPI_7.2.116_windows_amd64.zip',
      size: 21_044_954,
      version: '7.2.116',
    });
    expect(() =>
      parseCliProxyApiRelease(
        releasePayload({
          tag_name: 'latest',
        }),
      ),
    ).toThrow('版本格式');
    expect(() =>
      parseCliProxyApiRelease({
        ...releasePayload(),
        assets: [
          {
            browser_download_url: 'https://example.com/CLIProxyAPI.zip',
            digest: `sha256:${'a'.repeat(64)}`,
            name: 'CLIProxyAPI_7.2.116_windows_amd64.zip',
            size: 21_044_954,
          },
        ],
      }),
    ).toThrow('来源');
  });

  it('rejects archive traversal and absolute entries before extraction', () => {
    expect(archiveEntriesAreSafe(['cli-proxy-api.exe', 'config.example.yaml'])).toBe(true);
    expect(archiveEntriesAreSafe(['../cli-proxy-api.exe'])).toBe(false);
    expect(archiveEntriesAreSafe(['C:\\Windows\\system32\\tool.exe'])).toBe(false);
    expect(archiveEntriesAreSafe(['/absolute/tool.exe'])).toBe(false);
  });

  it('writes a loopback-only configuration without remote management or control panel', () => {
    const authDirectory = path.resolve('C:\\Users\\Tester\\ClaudeDock\\gateway-auth');
    const config = buildManagedGatewayConfig({
      authDirectory,
      clientKey: `sk-claudedock-${'x'.repeat(43)}`,
      port: 8317,
    });
    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain('port: 8317');
    expect(config).toContain('allow-remote: false');
    expect(config).toContain('disable-control-panel: true');
    expect(config).toContain('usage-statistics-enabled: false');
    expect(config).toContain(`sk-claudedock-${'x'.repeat(43)}`);
    expect(config).not.toMatch(/oauth|cookie|password/i);
  });
});
