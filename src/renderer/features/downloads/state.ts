import type {
  ApplicationUpdaterState,
  BusyLease,
  DownloadTaskView,
} from '../../../shared/contracts';

export const ACTIVE_DOWNLOAD_STATES = new Set<DownloadTaskView['state']>([
  'paused',
  'progressing',
  'queued',
  'verifying',
]);

export interface DownloadsState {
  applicationUpdater?: ApplicationUpdaterState;
  busyLeases: BusyLease[];
  tasks: DownloadTaskView[];
}

export const createDownloadsState = (): DownloadsState => ({
  busyLeases: [],
  tasks: [],
});
