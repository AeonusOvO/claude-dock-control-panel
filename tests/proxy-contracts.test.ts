import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

describe('built-in proxy integration contract', () => {
  it('keeps import as preview plus explicit selection', () => {
    expect(markup).toContain('id="proxy-import-preview"');
    expect(markup).toContain('id="proxy-save-selected"');
    expect(renderer).toContain("querySelectorAll<HTMLInputElement>('input:checked')");
    expect(main).toContain("ipcMain.handle('proxy:preview-subscription'");
    expect(main).toContain('downloadProxySubscription(requireDownloadEngine()');
  });

  it('exposes start, stop, scope, and audit only through the isolated bridge', () => {
    expect(preload).toContain("ipcRenderer.invoke('proxy:start', manualCorePath)");
    expect(preload).toContain("ipcRenderer.invoke('proxy:set-scope', scope)");
    expect(preload).toContain("ipcRenderer.on('proxy:audit-required', callback)");
    expect(main).toContain("requireNetworkPreflightService().invalidate('built-in-proxy-started')");
  });

  it('uses the required boundary copy and a safe default audit action', () => {
    expect(markup).toContain(
      '仅对 ClaudeDock 启动的 CLI 生效；不修改系统代理，不影响 Claude / Codex 桌面版。',
    );
    expect(markup).toMatch(/id="proxy-audit-return"[^>]*autofocus/);
    expect(markup).toContain('风险只会暂停接入动作，不会关闭已经运行的代理隧道。');
  });

  it('gates access rather than tearing down the running tunnel', () => {
    expect(main).toContain('proxyLeakAuditService.assertAccessAccepted(selectedProxyProfile());');
    expect(main).toContain("xraySidecar.getView().status === 'ready'");
    expect(main).not.toMatch(/assertAccessAccepted[\s\S]{0,200}xraySidecar\.stop/);
  });

  it('re-runs environment checks when the built-in proxy changes', () => {
    expect(main).toContain("invalidate('built-in-proxy-profile-changed')");
    expect(renderer).toContain("invalidateNetworkPreflight('built-in-proxy-state-changed')");
    expect(renderer).toContain('runActiveNetworkPreflight(true)');
    expect(main).toContain('cliEnvironment: () =>');
  });
});
