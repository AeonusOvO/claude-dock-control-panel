import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const sidecar = readFileSync(new URL('../src/main/proxy/xray-sidecar.ts', import.meta.url), 'utf8');
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
    expect(preload).toContain(
      "ipcRenderer.invoke('proxy:start', manualCorePath, acceptExternalTunnelChain)",
    );
    expect(preload).toContain("ipcRenderer.invoke('proxy:test-performance')");
    expect(preload).toContain("ipcRenderer.invoke('proxy:set-scope', scope)");
    expect(preload).toContain("ipcRenderer.on('proxy:audit-required', callback)");
    expect(main).toContain("requireNetworkPreflightService().invalidate('built-in-proxy-started')");
    expect(preload).toContain("ipcRenderer.invoke('proxy:delete-audit', recordId)");
    expect(preload).toContain("ipcRenderer.invoke('network:set-ipv6-disabled', disabled)");
    expect(contracts).toMatch(
      /export interface ProxyScopeSettings \{[\s\S]*?conversation: boolean;/,
    );
    expect(main).toContain("session.fromPartition('claudedock-conversation-network')");
    expect(main).toContain("ipcMain.handle('proxy:refresh-subscriptions'");
  });

  it('uses the required boundary copy and a safe default audit action', () => {
    expect(markup.replace(/\s+/g, ' ')).toContain(
      '仅对勾选的 CLI、对话或 ClaudeDock 自身网络生效；不修改系统代理，不影响 Claude / Codex 桌面版。',
    );
    expect(markup).toMatch(/id="proxy-audit-return"[^>]*autofocus/);
    expect(markup).toContain('“返回调整”会先断开正在运行的代理隧道。');
    expect(renderer).toContain('renderProxyState(await window.controlPanel.stopBuiltInProxy())');
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

  /*
   * Kernel state rides the view the panel already subscribes to, so 「未检测到内核」 can never be a
   * message that only appears after 启动 fails. The three kernel channels have to reach the renderer
   * through the same isolated bridge as everything else — a direct `ipcRenderer` reach would work in
   * development and break under contextIsolation in the packaged app.
   */
  it('carries kernel state and its install channels through the existing bridge', () => {
    expect(contracts).toMatch(/export interface ProxyControlView \{[\s\S]*?core: ProxyCoreView;/);
    expect(contracts).toMatch(
      /export interface ProxyCoreView \{[\s\S]*?installed: boolean;[\s\S]*?requiredVersion: string;[\s\S]*?sources: ProxyCoreSourceView\[\];/,
    );
    expect(contracts).toContain('export interface ProxyCoreSourceView {');
    expect(main).toContain('core: sidecar.getCoreView(),');
    for (const channel of [
      'proxy:probe-core-sources',
      'proxy:install-core',
      'proxy:install-core-file',
      'proxy:detect-bootstrap-proxy',
    ]) {
      expect(main).toContain(`ipcMain.handle('${channel}'`);
      expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
    }
    expect(main).toContain("throw new Error('内核文件路径必须是绝对路径。');");
    // Every mutating channel republishes the view, or the panel would show stale kernel state.
    expect(main).toMatch(
      /installCoreFromFile\(filePath\);\s+mainWindow\?\.webContents\.send\('proxy:state-changed'/,
    );
  });

  /*
   * Both the bootstrap proxy and the user's extra mirrors persist alongside the scope, which means a
   * partial `setProxyScope` write would blank them. Keeping them on the one existing channel is what
   * lets the renderer round-trip the whole object instead of inventing a second store.
   */
  it('persists the bootstrap proxy and user mirrors on the existing scope channel', () => {
    expect(contracts).toContain('bootstrapProxyUrl?: string;');
    expect(contracts).toContain('extraCoreSources?: string[];');
    expect(preload).toContain("ipcRenderer.invoke('proxy:set-scope', scope)");
    expect(main).not.toContain("ipcMain.handle('proxy:set-bootstrap-proxy'");
    expect(renderer).toContain('proxyScopeSnapshot = { ...state.store.scope };');
    expect(renderer).toMatch(/\.setProxyScope\(\{\s+\.\.\.proxyScopeSnapshot,/);
  });

  /*
   * The route the download actually takes is chosen by measured transfer rate, so that measurement
   * has to reach the panel: the first live run picked the lowest-latency mirror and then crawled the
   * 21 MB archive at ~13 KB/s with nothing on screen to explain why.
   */
  it('surfaces the measured transfer rate the route choice is based on', () => {
    expect(contracts).toMatch(
      /export interface ProxyCoreSourceView \{[\s\S]*?throughputBps\?: number;/,
    );
    expect(sidecar).toContain('throughputBps: result?.throughputBps,');
    expect(renderer).toContain('formatProxyCoreRate(source.throughputBps)');
  });

  /*
   * `powershell.exe -Command <string>` appends any trailing arguments to the command text and leaves
   * `$args` empty, so an `$args[0]` invocation fails parameter validation on every run — which is how
   * kernel extraction stayed broken behind an opaque 「退出码 1」 until the child's stderr was kept.
   */
  it('hands the extraction its paths through the environment, never through $args', () => {
    expect(sidecar).not.toMatch(/'Expand-Archive[^']*\$args/);
    expect(sidecar).toContain('-LiteralPath $env:CLAUDEDOCK_CORE_ARCHIVE');
    expect(sidecar).toContain('-DestinationPath $env:CLAUDEDOCK_CORE_DESTINATION');
    expect(sidecar).toMatch(/CLAUDEDOCK_CORE_ARCHIVE: archivePath,\s+CLAUDEDOCK_CORE_DESTINATION:/);
    expect(sidecar).toContain("child.stderr.on('data'");
  });
});
