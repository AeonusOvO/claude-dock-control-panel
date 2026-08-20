import { CHANNELS } from '../../shared/ipc/channels';
import { ipcMain } from 'electron';
import type { ArtifactService } from '../artifact/service';
import type { MainGuards } from './guards';

export interface ArtifactIpcDependencies {
  artifactService: ArtifactService;
  guards: Pick<MainGuards, 'validateSender'>;
}

export const registerArtifactIpc = ({
  artifactService,
  guards: { validateSender },
}: ArtifactIpcDependencies): void => {
  ipcMain.handle(CHANNELS.ARTIFACT_CREATE, (event, html: unknown) => {
    validateSender(event);
    if (typeof html !== 'string') {
      throw new Error('Artifact 内容格式无效。');
    }
    return artifactService.create(html);
  });
  ipcMain.handle(CHANNELS.ARTIFACT_DESTROY, (event, artifactId: unknown) => {
    validateSender(event);
    if (typeof artifactId !== 'string') {
      throw new Error('Artifact 标识无效。');
    }
    return artifactService.destroy(artifactId);
  });
  ipcMain.handle(CHANNELS.ARTIFACT_GET_NETWORK_STATE, (event) => {
    validateSender(event);
    return artifactService.getState();
  });
  ipcMain.handle(CHANNELS.ARTIFACT_SET_NETWORK_ALLOWED, (event, allowed: unknown) => {
    validateSender(event);
    if (typeof allowed !== 'boolean') {
      throw new Error('Artifact 联网开关取值无效。');
    }
    return artifactService.setNetworkAllowed(allowed);
  });
};
