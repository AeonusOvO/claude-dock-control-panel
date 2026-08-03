import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

describe('external application proxy integration contract', () => {
  it('exposes only host, port, credentials, and application scopes', () => {
    for (const id of [
      'application-proxy-host',
      'application-proxy-port',
      'application-proxy-username',
      'application-proxy-password',
      'application-proxy-scope-cli',
      'application-proxy-scope-application',
      'application-proxy-scope-conversation',
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(contracts).toContain("export type ApplicationProxyProtocol = 'http' | 'socks5';");
    expect(markup).not.toContain('id="proxy-import-preview"');
    expect(markup).not.toContain('id="proxy-core-install"');
  });

  it('keeps all proxy operations behind the isolated bridge', () => {
    for (const channel of [
      'application-proxy:get',
      'application-proxy:save',
      'application-proxy:test',
      'application-proxy:detect',
    ]) {
      expect(main).toContain(`ipcMain.handle('${channel}'`);
      expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
    }
    expect(preload).toContain("ipcRenderer.on('application-proxy:changed', callback)");
    expect(renderer).toContain('.saveApplicationProxy({');
  });

  it('does not ship runtime entry points for nodes, subscriptions, tunnels, or Xray', () => {
    for (const channel of [
      'proxy:preview-subscription',
      'proxy:save-profiles',
      'proxy:start',
      'proxy:install-core',
      'proxy:refresh-subscriptions',
    ]) {
      expect(main).not.toContain(`ipcMain.handle('${channel}'`);
      expect(preload).not.toContain(`ipcRenderer.invoke('${channel}'`);
    }
    expect(main).not.toContain('new XraySidecar');
  });

  it('states the product boundary next to the controls', () => {
    const compactMarkup = markup.replace(/\s+/g, ' ');
    expect(compactMarkup).toContain('ClaudeDock 不再提供节点、订阅、代理内核、隧道或跨境线路');
    expect(compactMarkup).toContain('旧版本保存的节点与 Xray 数据不会被启用');
  });
});
