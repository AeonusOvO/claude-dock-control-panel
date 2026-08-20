export type BackgroundTaskPriority = 'background' | 'interactive';

interface QueuedTask {
  operation: () => Promise<unknown>;
  priority: BackgroundTaskPriority;
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
}

/**
 * Bounds expensive I/O/process diagnostics without occupying worker threads for work that is
 * already asynchronous. Calls with the same key share one promise; interactive work jumps ahead
 * of background refreshes that have not started yet.
 */
export class BackgroundTaskCoordinator {
  private activeCount = 0;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue: QueuedTask[] = [];

  public constructor(private readonly maximumConcurrency = 2) {
    if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new Error('后台任务并发数必须是正整数。');
    }
  }

  public run<T>(
    key: string,
    priority: BackgroundTaskPriority,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const request = new Promise<T>((resolve, reject) => {
      const task: QueuedTask = {
        operation,
        priority,
        reject,
        resolve: (value) => resolve(value as T),
      };
      const firstBackgroundIndex =
        priority === 'interactive'
          ? this.queue.findIndex((queued) => queued.priority === 'background')
          : -1;
      if (firstBackgroundIndex === -1) {
        this.queue.push(task);
      } else {
        this.queue.splice(firstBackgroundIndex, 0, task);
      }
      this.drain();
    });
    this.inFlight.set(key, request);
    void request.then(
      () => this.clearInFlight(key, request),
      () => this.clearInFlight(key, request),
    );
    return request;
  }

  private clearInFlight(key: string, request: Promise<unknown>): void {
    if (this.inFlight.get(key) === request) {
      this.inFlight.delete(key);
    }
  }

  private drain(): void {
    while (this.activeCount < this.maximumConcurrency) {
      const task = this.queue.shift();
      if (!task) {
        return;
      }
      this.activeCount += 1;
      void Promise.resolve()
        .then(task.operation)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.drain();
        });
    }
  }
}
