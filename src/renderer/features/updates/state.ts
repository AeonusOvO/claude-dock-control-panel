import type { ApplicationUpdaterState, SoftwareUpdateState } from '../../../shared/contracts';

export interface UpdatesState {
  applicationUpdaterState?: ApplicationUpdaterState;
  softwareUpdateInProgress: boolean;
  softwareUpdatePromise?: Promise<void>;
  softwareUpdates?: SoftwareUpdateState;
  updateCenterOperationInProgress: boolean;
  updateRefreshInProgress: boolean;
}

export const createUpdatesState = (): UpdatesState => ({
  softwareUpdateInProgress: false,
  updateCenterOperationInProgress: false,
  updateRefreshInProgress: false,
});
