import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(
  new URL('../src/shared/contracts.ts', import.meta.url),
  'utf8',
);

describe('tray busy-state integration', () => {
  it('refreshes the tray whenever the authoritative busy registry changes', () => {
    expect(mainSource).toMatch(
      /busyRegistry = new BusyRegistry\(\(leases\) => \{\s+mainWindow\?\.webContents\.send\('busy:changed', leases\);\s+updateTray\(\);/,
    );
    expect(mainSource).toContain(
      "const downloadLeases = leases.filter(({ kind }) => kind === 'download');",
    );
    expect(mainSource).toContain(
      "const blockingLeases = leases.filter(({ severity }) => severity === 'blocking');",
    );
    expect(mainSource).toContain("? '后台空闲'");
  });

  it('only adds the native download-center command while downloads are active', () => {
    expect(mainSource).toContain('...(downloadLeases.length > 0');
    expect(mainSource).toContain('`打开下载中心（${downloadLeases.length}）`');
    expect(mainSource).toContain("mainWindow?.webContents.send('app:open-download-center');");
  });

  it('routes the native command through the isolated renderer bridge', () => {
    expect(contractsSource).toContain(
      'onOpenDownloadCenterRequested: (listener: () => void) => Unsubscribe;',
    );
    expect(preloadSource).toContain("ipcRenderer.on('app:open-download-center', callback);");
    expect(rendererSource).toContain(
      'window.controlPanel.onOpenDownloadCenterRequested(openDownloadCenter)',
    );
    expect(rendererSource).toContain('unsubscribeOpenDownloadCenterRequested();');
  });
});
