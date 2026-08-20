import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import { validateDownloadTaskId } from './validation';
import type { MainGuards } from './guards';

export interface DownloadIpcDependencies {
  guards: Pick<MainGuards, 'requireDownloadEngine' | 'validateSender'>;
}

export const registerDownloadIpc = ({
  guards: { requireDownloadEngine, validateSender },
}: DownloadIpcDependencies): void => {
  ipcMain.handle(CHANNELS.DOWNLOAD_LIST, (event) => {
    validateSender(event);
    return requireDownloadEngine().list();
  });
  ipcMain.handle(CHANNELS.DOWNLOAD_PAUSE, (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().pause(validateDownloadTaskId(taskId));
  });
  ipcMain.handle(CHANNELS.DOWNLOAD_RESUME, (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().resume(validateDownloadTaskId(taskId));
  });
  ipcMain.handle(CHANNELS.DOWNLOAD_CANCEL, (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().cancel(validateDownloadTaskId(taskId));
  });
  ipcMain.handle(CHANNELS.DOWNLOAD_HISTORY_DELETE, (event, taskId: unknown) => {
    validateSender(event);
    return requireDownloadEngine().deleteHistory(validateDownloadTaskId(taskId));
  });
  ipcMain.handle(CHANNELS.DOWNLOAD_HISTORY_CLEAR, (event) => {
    validateSender(event);
    return requireDownloadEngine().clearHistory();
  });
};
