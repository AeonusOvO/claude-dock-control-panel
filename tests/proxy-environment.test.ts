import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCliProxyEnvironment,
  builtInProxyRules,
  normalizeBootstrapProxyUrl,
} from '../src/main/proxy/proxy-environment';

const runtime = {
  coreVersion: 'test',
  httpProxyUrl: 'http://127.0.0.1:43123',
  logs: [],
  status: 'ready' as const,
};

describe('CLI-only built-in proxy scope', () => {
  it('injects an HTTP loopback adapter and always bypasses local services', () => {
    expect(
      buildCliProxyEnvironment(
        runtime,
        { application: false, cli: true, conversation: false },
        'example.test',
      ),
    ).toMatchObject({
      ALL_PROXY: null,
      CLAUDEDOCK_BUILT_IN_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:43123',
      HTTP_PROXY: 'http://127.0.0.1:43123',
      NO_PROXY: '127.0.0.1,localhost,::1,example.test',
    });
  });

  it('keeps application proxying opt-in and never overrides the Windows proxy setting', () => {
    expect(
      builtInProxyRules(runtime, { application: false, cli: true, conversation: false }),
    ).toEqual({
      mode: 'system',
    });
    expect(
      builtInProxyRules(runtime, { application: true, cli: true, conversation: false }),
    ).toEqual({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:43123',
    });
  });

  /*
   * The Xray-core bootstrap downloads through Chromium's default session, and `setProxy` +
   * `closeAllConnections()` kills that socket. main.ts only skips the call when the new rules match
   * the last ones applied, so a sidecar that is merely `starting` must resolve to the same rules as
   * a stopped one — otherwise every first start tears down its own bootstrap download at 0 bytes.
   */
  it('resolves a starting tunnel to the same rules as a stopped one', () => {
    for (const scope of [
      { application: false, cli: true, conversation: false },
      { application: true, cli: true, conversation: false },
    ]) {
      const stopped = builtInProxyRules({ coreVersion: '', logs: [], status: 'stopped' }, scope);

      for (const status of ['starting', 'stopping', 'error'] as const) {
        expect(builtInProxyRules({ coreVersion: '', logs: [], status }, scope)).toEqual(stopped);
      }
      expect(builtInProxyRules(undefined, scope)).toEqual(stopped);
      expect(stopped).toEqual({ mode: 'system' });
    }
  });

  /*
   * The bootstrap proxy exists purely so a user who already has working connectivity can point the
   * kernel download at it. It is never inferred: an empty field has to stay `{mode:'system'}`, and a
   * live tunnel still outranks it, or turning the built-in proxy on would silently do nothing.
   */
  it('uses the bootstrap proxy only while the tunnel is not carrying traffic', () => {
    const scope = {
      application: false,
      bootstrapProxyUrl: 'http://127.0.0.1:10808',
      cli: true,
      conversation: false,
    };
    expect(builtInProxyRules({ coreVersion: '', logs: [], status: 'stopped' }, scope)).toEqual({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:10808',
    });
    expect(builtInProxyRules(runtime, { ...scope, application: true })).toEqual({
      mode: 'fixed_servers',
      proxyBypassRules: '127.0.0.1,localhost,[::1]',
      proxyRules: 'http://127.0.0.1:43123',
    });
    expect(
      builtInProxyRules(runtime, { application: false, cli: true, conversation: false }),
    ).toEqual({
      mode: 'system',
    });
    expect(
      builtInProxyRules(runtime, {
        application: false,
        bootstrapProxyUrl: '   ',
        cli: true,
        conversation: false,
      }),
    ).toEqual({ mode: 'system' });
  });

  it('refuses bootstrap URLs that Chromium cannot use or that would leak a secret', () => {
    expect(normalizeBootstrapProxyUrl('http://127.0.0.1:10808')).toBe('http://127.0.0.1:10808');
    expect(normalizeBootstrapProxyUrl(' socks5://127.0.0.1:1080/ ')).toBe(
      'socks5://127.0.0.1:1080',
    );
    // Credentials would end up verbatim in the diagnostic ring and in audit records.
    expect(normalizeBootstrapProxyUrl('http://user:pass@127.0.0.1:10808')).toBeUndefined();
    expect(normalizeBootstrapProxyUrl('https://127.0.0.1:10808')).toBeUndefined();
    expect(normalizeBootstrapProxyUrl('socks5://127.0.0.1')).toBeUndefined();
    expect(normalizeBootstrapProxyUrl('127.0.0.1:10808')).toBeUndefined();
    expect(normalizeBootstrapProxyUrl('')).toBeUndefined();
    expect(normalizeBootstrapProxyUrl(undefined)).toBeUndefined();
  });

  /*
   * Whatever proxy this machine happens to run says nothing about the next user's machine, so the
   * detector may only ever produce a list of candidates for the panel to offer.
   */
  it('detects bootstrap candidates without ever applying one', () => {
    const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const start = mainSource.indexOf('const detectBootstrapProxyCandidates');
    expect(start).toBeGreaterThan(-1);
    const body = mainSource.slice(start, mainSource.indexOf('\n};', start));
    expect(body).toContain("resolveProxy('https://github.com')");
    expect(body).not.toContain('setScope');
    expect(body).not.toContain('bootstrapProxyUrl:');
  });

  it('primes the applied proxy rules before anything can start the tunnel', () => {
    const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const constructorIndex = mainSource.indexOf('xraySidecar = new XraySidecar(');

    expect(constructorIndex).toBeGreaterThan(-1);
    // The priming call sits with the constructor, not inside the start/stop paths further up.
    expect(mainSource.slice(constructorIndex, constructorIndex + 1800)).toContain(
      'await applyApplicationProxyScope();',
    );
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
