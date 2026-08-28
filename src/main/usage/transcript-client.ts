import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TranscriptUsageRequest, TranscriptUsageResult } from './transcript-reader';

export interface TranscriptUsageReply {
  epoch: string;
  results?: TranscriptUsageResult[];
  unavailable?: boolean;
}

/** One lazy worker, one coalesced batch every ten seconds, no work on terminal output hot paths. */
export class TranscriptUsageClient {
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private readonly pending = new Map<string, TranscriptUsageRequest>();
  private active?: TranscriptUsageRequest;
  private closed = false;

  public constructor(
    private readonly projectsRoot: string,
    private readonly onReply: (reply: TranscriptUsageReply) => void,
  ) {}

  public schedule(request: TranscriptUsageRequest): void {
    if (this.closed) return;
    this.pending.set(request.file, request);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 10_000);
    this.timer.unref();
  }

  private flush(): void {
    if (this.closed || this.active || !this.pending.size) return;
    if (!this.worker) {
      try {
        const worker = new Worker(path.join(__dirname, 'transcript-worker.js'), {
          workerData: { projectsRoot: this.projectsRoot },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
        this.worker = worker;
        worker.on('message', (reply: TranscriptUsageReply) => {
          if (this.worker !== worker) return;
          this.active = undefined;
          this.onReply(reply);
          this.flush();
        });
        worker.on('error', () => {
          if (this.worker !== worker) return;
          this.worker = undefined;
          if (this.active) this.onReply({ epoch: this.active.epoch, unavailable: true });
          this.active = undefined;
          for (const request of this.pending.values())
            this.onReply({ epoch: request.epoch, unavailable: true });
          this.pending.clear();
        });
        worker.unref();
      } catch {
        for (const request of this.pending.values())
          this.onReply({ epoch: request.epoch, unavailable: true });
      }
    }
    const next = this.pending.values().next().value;
    if (this.worker && next) {
      this.pending.delete(next.file);
      this.active = next;
      this.worker.postMessage(next);
    }
  }

  public reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.active = undefined;
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }

  public dispose(): void {
    this.closed = true;
    this.reset();
  }
}
