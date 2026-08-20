import type { FailureMetadata } from '../diagnostics/failure';

export interface SoftwareUpdateTarget {
  currentVersion?: string;
  installed: boolean;
  latestVersion?: string;
  message: string;
  updateAvailable: boolean;
}

export interface SoftwareUpdateState {
  application: SoftwareUpdateTarget;
  checkedAt: number;
  claudeCode: SoftwareUpdateTarget;
  router: SoftwareUpdateTarget;
}

export interface SoftwareUpdateOperationResult extends FailureMetadata {
  error?: string;
  message: string;
  ok: boolean;
  state: SoftwareUpdateState;
}

export type ApplicationUpdaterPhase =
  | 'available'
  | 'checking'
  | 'disabled'
  | 'downloaded'
  | 'downloading'
  | 'error'
  | 'idle'
  | 'up-to-date';

export interface ApplicationUpdaterState {
  bytesPerSecond?: number;
  currentVersion: string;
  downloadedBytes?: number;
  latestVersion?: string;
  message: string;
  percent?: number;
  phase: ApplicationUpdaterPhase;
  sourceId?: string;
  sourceLabel?: string;
  sourceThroughputBps?: number;
  totalBytes?: number;
}
