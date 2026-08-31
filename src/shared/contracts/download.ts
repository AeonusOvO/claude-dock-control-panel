export type DownloadTaskState =
  'cancelled' | 'completed' | 'failed' | 'paused' | 'progressing' | 'queued' | 'verifying';

export interface DownloadTaskView {
  bytesPerSecond: number;
  canPause: boolean;
  canResume: boolean;
  elapsedMs: number;
  errorMessage?: string;
  finishedAt?: number;
  id: string;
  label: string;
  percent: number;
  receivedBytes: number;
  remainingMs: number;
  /** True when this interrupted task is waiting for an explicit resume/discard decision. */
  recoveryPending?: boolean;
  /** Opaque main-process token binding a recovery decision to this task instance. */
  recoveryToken?: string;
  startedAt?: number;
  state: DownloadTaskState;
  totalBytes: number;
}
