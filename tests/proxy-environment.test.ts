import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCliProxyEnvironment, builtInProxyRules } from '../src/main/proxy/proxy-environment';

const runtime = {
  coreVersion: 'test',
  httpProxyUrl: 'http://127.0.0.1:43123',
  logs: [],
  status: 'ready' as const,
};

describe('CLI-only built-in proxy scope', () => {
  it('injects an HTTP loopback adapter and always bypasses local services', () => {
    expect(
      buildCliProxyEnvironment(runtime, { application: false, cli: true }, 'example.test'),
    ).toMatchObject({
      ALL_PROXY: null,
      CLAUDEDOCK_BUILT_IN_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:43123',
      HTTP_PROXY: 'http://127.0.0.1:43123',
      NO_PROXY: '127.0.0.1,localhost,::1,example.test',
    });
  });

  it('keeps application proxying opt-in and has no system-proxy mode', () => {
    expect(builtInProxyRules(runtime, { application: false, cli: true })).toEqual({
      mode: 'direct',
    });
    expect(builtInProxyRules(runtime, { application: true, cli: true })).toEqual({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:43123',
    });
  });

  it('contains no write path for system or desktop-app proxy configuration', () => {
    const files = [
      '../src/main/proxy/proxy-environment.ts',
      '../src/main/proxy/xray-sidecar.ts',
      '../src/main/proxy/proxy-store.ts',
    ];
    const source = files
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/setx|Internet Settings|ProxyEnable|ProxyServer/i);
    expect(source).not.toMatch(/claude_desktop_config\.json|Codex(?:\\|\/)config/i);
  });
});
