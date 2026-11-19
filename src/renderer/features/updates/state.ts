import type {
  ApplicationUpdaterState,
  DownloadTaskView,
  SoftwareUpdateState,
} from '../../../shared/contracts';

export type UpdateCenterTab = 'history' | 'pending';

export interface UpdatesState {
  applicationUpdaterState?: ApplicationUpdaterState;
  downloadHistory: DownloadTaskView[];
  claudeInstallPromise?: Promise<boolean>;
  softwareUpdateInProgress: boolean;
  softwareUpdatePromise?: Promise<void>;
  softwareUpdates?: SoftwareUpdateState;
  updateCenterOperationInProgress: boolean;
  updateCenterTab: UpdateCenterTab;
  updateRefreshInProgress: boolean;
}

export const createUpdatesState = (): UpdatesState => ({
  downloadHistory: [],
  softwareUpdateInProgress: false,
  updateCenterOperationInProgress: false,
  updateCenterTab: 'pending',
  updateRefreshInProgress: false,
});
