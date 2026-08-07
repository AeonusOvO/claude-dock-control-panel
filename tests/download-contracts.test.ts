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
const codexInstallerSource = readFileSync(
  new URL('../src/main/codex-installer.ts', import.meta.url),
  'utf8',
);
const windowsCommandSource = readFileSync(
  new URL('../src/main/windows-command.ts', import.meta.url),
  'utf8',
);
const rendererMarkup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const rendererStyles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

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
    expect(mainSource).toContain("ipcMain.handle('download:history-delete'");
    expect(mainSource).toContain("ipcMain.handle('download:history-clear'");
    expect(preloadSource).toContain("ipcRenderer.invoke('download:history-delete'");
    expect(preloadSource).toContain("ipcRenderer.invoke('download:history-clear'");
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

  it('installs CCR as a deduplicated CLI task with a recoverable journal', () => {
    expect(routerManagerSource).toContain("'@musistudio/claude-code-router@latest'");
    expect(routerManagerSource).toContain('private installInFlight?');
    expect(routerManagerSource).toContain("'router-operation.json'");
    expect(routerManagerSource).toContain('recoverInterruptedInstall()');
    expect(routerManagerSource).not.toContain('Claude Code Router 安装包');
    expect(preloadSource).toContain("ipcRenderer.on('router:operation-progress', callback)");
  });

  it('routes Codex downloads through the engine and streams installer output', () => {
    expect(codexInstallerSource).toContain('await this.downloadEngine.start({');
    expect(codexInstallerSource).toContain("label: 'Codex 官方安装脚本'");
    expect(codexInstallerSource).not.toContain('this.fetchImplementation(release.downloadUrl');
    expect(codexInstallerSource).toContain('onLine: this.onInstallLine');
    expect(windowsCommandSource).toContain('options.onLine?.(line, stream)');
  });

  it('renders a themed download center with determinate and indeterminate progress', () => {
    expect(rendererMarkup).toContain('id="download-center-dialog"');
    expect(rendererMarkup).toContain('id="download-progress-template"');
    expect(rendererSource).toContain(
      "appendMetric('已用', formatDownloadDuration(task.elapsedMs))",
    );
    expect(rendererSource).toContain("appendDownloadAction(actions, task, 'pause', '暂停')");
    expect(rendererSource).toContain("appendDownloadAction(actions, task, 'resume', '继续')");
    expect(rendererSource).toContain("appendDownloadAction(actions, task, 'cancel', '取消')");
    expect(rendererSource).toContain("configure: '配置'");
    expect(rendererSource).toContain("update: '更新'");
    expect(rendererSource).toContain('lease.stage ?? `${actionLabel}中`');
    expect(rendererSource).toContain("'已用时间',");
    expect(rendererSource).toContain("log.className = 'download-task__log'");
    expect(rendererSource).not.toContain("style.width = '42%'");
    expect(rendererSource).toContain('window.controlPanel.deleteDownloadHistory(task.id)');
    expect(rendererSource).toContain('window.controlPanel.clearDownloadHistory()');
    expect(rendererMarkup).toContain('id="download-history-list"');
    expect(rendererMarkup).toContain('id="clear-download-history"');
    expect(rendererStyles).toContain(".download-progress[data-indeterminate='true']");
    expect(rendererStyles).toContain('var(--dur-progress)');
  });

  /*
   * `percent` stays at -1 for the whole life of a download whose server never sent a length, so a
   * spinner keyed on the number alone kept sweeping after the task had already failed — the download
   * center claimed it was still trying while the card underneath read 下载失败.
   */
  it('stops the progress animation once a download reaches a terminal state', () => {
    expect(rendererSource).toMatch(
      /const settled =\s*task\.state === 'cancelled' \|\| task\.state === 'completed' \|\| task\.state === 'failed';/,
    );
    expect(rendererSource).toContain('const indeterminate = !settled && task.percent < 0;');
    expect(rendererSource).not.toContain('const indeterminate = task.percent < 0;');
  });
});
