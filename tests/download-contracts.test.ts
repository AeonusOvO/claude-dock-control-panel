import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contractsSource = readFileSync(
  new URL('../src/shared/contracts.ts', import.meta.url),
  'utf8',
);
const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const routerManagerSource = readFileSync(
  new URL('../src/main/claude-router-manager.ts', import.meta.url),
  'utf8',
);

describe('download IPC surface', () => {
  it('keeps list, commands and changed subscription wired across the process boundary', () => {
    for (const action of ['list', 'pause', 'resume', 'cancel']) {
      expect(mainSource).toContain(`ipcMain.handle('download:${action}'`);
      expect(preloadSource).toContain(`ipcRenderer.invoke('download:${action}'`);
    }
    expect(mainSource).toContain("webContents.send('download:changed', tasks)");
    expect(preloadSource).toContain("ipcRenderer.on('download:changed', callback)");
    expect(preloadSource).toContain("ipcRenderer.removeListener('download:changed', callback)");
    expect(rendererSource).toContain(
      'window.controlPanel.onDownloadsChanged(handleDownloadsChanged)',
    );
    expect(contractsSource).toContain(
      'onDownloadsChanged: (listener: (tasks: DownloadTaskView[]) => void) => Unsubscribe;',
    );
  });

  it('validates the sender and task id before every download mutation', () => {
    for (const action of ['pause', 'resume', 'cancel']) {
      expect(mainSource).toMatch(
        new RegExp(
          `ipcMain\\.handle\\('download:${action}',[\\s\\S]*?validateSender\\(event\\);[\\s\\S]*?validateDownloadTaskId\\(taskId\\)`,
        ),
      );
    }
  });

  it('routes the CCR installer through the shared verified download engine', () => {
    expect(routerManagerSource).toContain('await this.downloadEngine.start({');
    expect(routerManagerSource).toContain("label: 'Claude Code Router 安装包'");
    expect(routerManagerSource).not.toContain('response.body.getReader()');
  });
});
